//! Request-scoped background work (P04-CR-004).
//!
//! Work that must outlive the response body, such as settling a request after the
//! caller disconnected, has to be registered with the request's execution context or
//! the runtime is free to cancel it. `BackgroundWork` is the one explicit port for
//! that: it wraps `worker::Context::wait_until` and is passed per request, never held
//! in a global.
//!
//! Disconnect is not a reliable signal. The probe (P04-CR-004) showed the abort event
//! and the stream drop never ran, and registering a request-long `wait_until` that is
//! only released on drop (a "hold") kept the provider streaming for its full length while
//! settling nothing. So settlement does not depend on the disconnect being noticed:
//! `BackgroundWork::watch` registers a *bounded* task at stream start that sleeps on a
//! real timer until the request deadline plus a grace period and then settles through the
//! same once-only latch. It ends early when the stream state is dropped.

use std::{
    cell::{Cell, RefCell},
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::Arc,
    task::{Context, Poll, Waker},
    time::Duration,
};

use futures_util::future::{Either, select};

/// How long past the request deadline the watchdog waits, so a live stream's own
/// timeout path settles first and records `request_timeout`.
pub(crate) const WATCHDOG_GRACE_MS: f64 = 2_000.0;

/// Milliseconds from `now_ms` until the watchdog fires.
pub(crate) fn watchdog_delay_ms(deadline_at_ms: f64, now_ms: f64) -> f64 {
    (deadline_at_ms - now_ms).max(0.0) + WATCHDOG_GRACE_MS
}

/// Where request-scoped work is registered. A trait so the once-only and
/// release-on-failure logic is testable without a Worker runtime.
pub(crate) trait LocalSpawn {
    fn run(&self, future: Pin<Box<dyn Future<Output = ()>>>);
}

#[derive(Clone)]
pub(crate) struct BackgroundWork {
    /// `None` only for paths that never run inside a Worker request.
    context: Option<Arc<worker::Context>>,
}

impl BackgroundWork {
    pub(crate) fn from_context(context: worker::Context) -> Self {
        Self {
            context: Some(Arc::new(context)),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn detached() -> Self {
        Self { context: None }
    }

    /// Settle the request after `delay_ms` unless the returned `Watchdog` is dropped
    /// first. The wait is a timer, so the registration is bounded and never idle.
    pub(crate) fn watch<F, Fut>(
        &self,
        delay_ms: f64,
        finalized: Rc<Cell<bool>>,
        settle: F,
    ) -> Watchdog
    where
        F: FnOnce() -> Fut + 'static,
        Fut: Future<Output = Result<(), String>> + 'static,
    {
        let delay = worker::Delay::from(Duration::from_millis(delay_ms as u64));
        watch_with(self, delay, finalized, settle)
    }
}

impl LocalSpawn for BackgroundWork {
    /// With a context the runtime keeps the request alive until the future
    /// completes; without one the task is only best-effort.
    fn run(&self, future: Pin<Box<dyn Future<Output = ()>>>) {
        match &self.context {
            Some(context) => context.wait_until(future),
            None => wasm_bindgen_futures::spawn_local(future),
        }
    }
}

#[derive(Default)]
struct WatchShared {
    released: Cell<bool>,
    waker: RefCell<Option<Waker>>,
}

/// Ends the watchdog task early when dropped (the stream finished or was dropped).
pub(crate) struct Watchdog {
    shared: Rc<WatchShared>,
}

struct Released(Rc<WatchShared>);

impl Future for Released {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0.released.get() {
            return Poll::Ready(());
        }
        *self.0.waker.borrow_mut() = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.shared.released.set(true);
        if let Some(waker) = self.shared.waker.borrow_mut().take() {
            waker.wake();
        }
    }
}

fn watch_with<W, S, F, Fut>(work: &W, sleep: S, finalized: Rc<Cell<bool>>, settle: F) -> Watchdog
where
    W: LocalSpawn,
    S: Future<Output = ()> + 'static,
    F: FnOnce() -> Fut + 'static,
    Fut: Future<Output = Result<(), String>> + 'static,
{
    let shared = Rc::new(WatchShared::default());
    let released = Released(shared.clone());
    work.run(Box::pin(async move {
        futures_util::pin_mut!(sleep, released);
        if let Either::Right(_) = select(sleep, released).await {
            trace_stream("watchdog:released");
            return;
        }
        let Some(claim) = LatchClaim::take(&finalized) else {
            trace_settle("watchdog:already_settled");
            return;
        };
        trace_settle("watchdog:fired");
        match settle().await {
            Ok(()) => {
                claim.keep();
                trace_settle("watchdog:ok");
            }
            Err(code) => {
                claim.release();
                trace_settle(&format!("watchdog:err:{code}"));
            }
        }
    }));
    trace_stream("watchdog:registered");
    Watchdog { shared }
}

/// A once-only claim on the settlement latch shared by every settlement path.
///
/// Dropping an unfinished claim releases the latch. That covers a failed write and a
/// future the runtime dropped mid-await; without it the latch stays set for a
/// settlement that will never finish and blocks every other path.
pub(crate) struct LatchClaim {
    latch: Rc<Cell<bool>>,
    armed: bool,
}

impl LatchClaim {
    /// `None` when another path already holds or finished the settlement.
    pub(crate) fn take(latch: &Rc<Cell<bool>>) -> Option<Self> {
        if latch.replace(true) {
            return None;
        }
        Some(Self {
            latch: latch.clone(),
            armed: true,
        })
    }

    /// The write succeeded: the latch stays set.
    pub(crate) fn keep(mut self) {
        self.armed = false;
    }

    /// The write failed: let another path settle.
    pub(crate) fn release(mut self) {
        self.armed = false;
        self.latch.set(false);
    }
}

impl Drop for LatchClaim {
    fn drop(&mut self) {
        if self.armed {
            self.latch.set(false);
            trace_settle("claim_dropped");
        }
    }
}

/// Settle a cancelled request exactly once, through request-scoped background work.
///
/// `finalized` is the once-only latch shared with every other settlement path. It is
/// taken before scheduling so two triggers (abort event and stream drop) cannot both
/// write, and it is **released if the write fails or the future is dropped** so a later
/// path (timeout, stream end, expiry sweep) can still settle instead of leaving the
/// reservation stranded. `settle` yields `Err(code)` with a bounded, non-sensitive code.
pub(crate) fn schedule_cancel_settlement<W, F, Fut>(work: &W, finalized: Rc<Cell<bool>>, settle: F)
where
    W: LocalSpawn,
    F: FnOnce() -> Fut + 'static,
    Fut: Future<Output = Result<(), String>> + 'static,
{
    let Some(claim) = LatchClaim::take(&finalized) else {
        return;
    };
    trace_settle("scheduled");
    work.run(Box::pin(async move {
        match settle().await {
            Ok(()) => {
                claim.keep();
                trace_settle("ok");
            }
            Err(code) => {
                claim.release();
                trace_settle(&format!("err:{code}"));
            }
        }
    }));
}

/// Wall-clock origin of one stream, used only to print elapsed milliseconds.
#[derive(Clone, Copy)]
pub(crate) struct StreamClock(f64);

impl StreamClock {
    pub(crate) fn start() -> Self {
        Self(now_ms())
    }

    fn elapsed_ms(self) -> i64 {
        (now_ms() - self.0).max(0.0) as i64
    }
}

/// One bounded lifecycle line: a fixed stage word and elapsed time. No request id,
/// org id, prompt, header or secret can reach it.
pub(crate) fn trace_lifecycle(clock: StreamClock, stage: &str) {
    trace_stream(&format!("{stage}@{}ms", clock.elapsed_ms()));
}

/// Marks one pending read of the provider stream. If the pull future is dropped while
/// the read is outstanding (the runtime cancelled it) a line says so; a read that
/// ends normally stays silent after the first two, so the volume is bounded.
pub(crate) struct PullScope {
    clock: StreamClock,
    ordinal: u8,
    open: bool,
}

impl PullScope {
    pub(crate) fn begin(clock: StreamClock, pulls: &mut u8) -> Self {
        *pulls = pulls.saturating_add(1);
        let scope = Self {
            clock,
            ordinal: *pulls,
            open: true,
        };
        if scope.ordinal <= 2 {
            trace_lifecycle(clock, &format!("pull_begin:{}", scope.ordinal));
        }
        scope
    }

    pub(crate) fn end(mut self, outcome: &str) {
        self.open = false;
        if self.ordinal <= 2 || outcome != "chunk" {
            trace_lifecycle(self.clock, &format!("pull_end:{}:{outcome}", self.ordinal));
        }
    }
}

impl Drop for PullScope {
    fn drop(&mut self) {
        if self.open {
            trace_lifecycle(
                self.clock,
                &format!("pull_dropped_pending:{}", self.ordinal),
            );
        }
    }
}

fn now_ms() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        worker::js_sys::Date::now()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

fn trace_settle(stage: &str) {
    emit(&format!("inference_cancel_finalize:{stage}"));
}

fn trace_stream(stage: &str) {
    emit(&format!("inference_stream_trace:{stage}"));
}

/// Settlement lines from paths that run inside the stream rather than after it.
pub(crate) fn trace_inline(stage: &str) {
    trace_settle(&format!("inline:{stage}"));
}

fn emit(line: &str) {
    #[cfg(target_arch = "wasm32")]
    worker::console_error!("{line}");
    #[cfg(test)]
    captured::push(line);
    #[cfg(all(not(target_arch = "wasm32"), not(test)))]
    let _ = line;
}

#[cfg(test)]
mod captured {
    use std::cell::RefCell;

    thread_local! {
        static LINES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) fn push(line: &str) {
        LINES.with(|lines| lines.borrow_mut().push(line.to_owned()));
    }

    pub(super) fn take() -> Vec<String> {
        LINES.with(|lines| std::mem::take(&mut *lines.borrow_mut()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    #[derive(Default)]
    struct Collector(RefCell<Vec<Pin<Box<dyn Future<Output = ()>>>>>);

    impl LocalSpawn for Collector {
        fn run(&self, future: Pin<Box<dyn Future<Output = ()>>>) {
            self.0.borrow_mut().push(future);
        }
    }

    fn drain(work: &Collector) -> usize {
        let tasks: Vec<_> = work.0.borrow_mut().drain(..).collect();
        let count = tasks.len();
        for task in tasks {
            task.now_or_never().expect("settlement future is ready");
        }
        count
    }

    #[test]
    fn nothing_runs_until_the_work_is_driven_and_it_runs_once() {
        let work = Collector::default();
        let latch = Rc::new(Cell::new(false));
        let writes = Rc::new(Cell::new(0));
        for _ in 0..2 {
            let writes = writes.clone();
            schedule_cancel_settlement(&work, latch.clone(), move || async move {
                writes.set(writes.get() + 1);
                Ok(())
            });
        }
        assert_eq!(writes.get(), 0, "scheduling must not run the write inline");
        assert_eq!(drain(&work), 1, "abort + drop trigger one settlement");
        assert_eq!(writes.get(), 1);
        assert!(latch.get(), "a successful settlement keeps the latch");
    }

    #[test]
    fn failed_write_releases_the_latch_so_another_path_can_settle() {
        let work = Collector::default();
        let latch = Rc::new(Cell::new(false));
        schedule_cancel_settlement(&work, latch.clone(), || async {
            Err("database_unavailable".to_owned())
        });
        assert!(latch.get(), "latched while the write is outstanding");
        drain(&work);
        assert!(!latch.get(), "latch released after the failed write");

        let writes = Rc::new(Cell::new(0));
        let again = writes.clone();
        schedule_cancel_settlement(&work, latch.clone(), move || async move {
            again.set(again.get() + 1);
            Ok(())
        });
        drain(&work);
        assert_eq!(writes.get(), 1);
        assert!(latch.get());
    }

    #[test]
    fn already_settled_request_is_not_written_again() {
        let work = Collector::default();
        let latch = Rc::new(Cell::new(true));
        schedule_cancel_settlement(&work, latch, || async { Ok(()) });
        assert_eq!(drain(&work), 0);
    }

    #[test]
    fn scheduled_settlement_the_runtime_drops_releases_the_latch() {
        captured::take();
        let work = Collector::default();
        let latch = Rc::new(Cell::new(false));
        schedule_cancel_settlement(&work, latch.clone(), || async { Ok(()) });
        assert!(latch.get());
        // The runtime cancels the registered task before it ever runs.
        work.0.borrow_mut().clear();
        assert!(
            !latch.get(),
            "a dropped settlement must not strand the latch"
        );
        assert_eq!(
            captured::take(),
            [
                "inference_cancel_finalize:scheduled",
                "inference_cancel_finalize:claim_dropped"
            ]
        );
    }

    #[test]
    fn claim_dropped_mid_await_releases_but_finished_claim_keeps() {
        let latch = Rc::new(Cell::new(false));
        let claim = LatchClaim::take(&latch).expect("free latch");
        assert!(LatchClaim::take(&latch).is_none(), "second claim refused");
        drop(claim);
        assert!(!latch.get());

        LatchClaim::take(&latch).expect("free again").keep();
        assert!(latch.get(), "a completed settlement stays settled");
        assert!(LatchClaim::take(&latch).is_none());
    }

    fn sleeper(ready: Rc<Cell<bool>>) -> impl Future<Output = ()> {
        std::future::poll_fn(move |_| {
            if ready.get() {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
    }

    #[test]
    fn watchdog_settles_an_abandoned_request_when_the_timer_fires() {
        captured::take();
        let work = Collector::default();
        let latch = Rc::new(Cell::new(false));
        let writes = Rc::new(Cell::new(0));
        let fire = Rc::new(Cell::new(false));
        let counted = writes.clone();
        let _watch = watch_with(
            &work,
            sleeper(fire.clone()),
            latch.clone(),
            move || async move {
                counted.set(counted.get() + 1);
                Ok(())
            },
        );
        let mut task = work.0.borrow_mut().pop().expect("watchdog registered");

        assert!(
            task.as_mut().now_or_never().is_none(),
            "idle before the timer"
        );
        assert_eq!(writes.get(), 0);
        fire.set(true);
        task.as_mut().now_or_never().expect("timer fired");
        assert_eq!(writes.get(), 1);
        assert!(latch.get(), "the settlement is kept");
        assert_eq!(
            captured::take(),
            [
                "inference_stream_trace:watchdog:registered",
                "inference_cancel_finalize:watchdog:fired",
                "inference_cancel_finalize:watchdog:ok"
            ]
        );
    }

    #[test]
    fn watchdog_ends_without_writing_when_the_stream_state_is_dropped() {
        let work = Collector::default();
        let latch = Rc::new(Cell::new(false));
        let writes = Rc::new(Cell::new(0));
        let counted = writes.clone();
        let watch = watch_with(
            &work,
            sleeper(Rc::new(Cell::new(false))),
            latch.clone(),
            move || async move {
                counted.set(counted.get() + 1);
                Ok(())
            },
        );
        let mut task = work.0.borrow_mut().pop().expect("watchdog registered");
        assert!(task.as_mut().now_or_never().is_none());
        drop(watch);
        task.as_mut().now_or_never().expect("released");
        assert_eq!(writes.get(), 0);
        assert!(!latch.get(), "nothing was settled by the watchdog");
    }

    #[test]
    fn watchdog_skips_a_request_another_path_already_settled() {
        let work = Collector::default();
        let latch = Rc::new(Cell::new(true));
        let writes = Rc::new(Cell::new(0));
        let counted = writes.clone();
        let _watch = watch_with(&work, async {}, latch, move || async move {
            counted.set(counted.get() + 1);
            Ok(())
        });
        assert_eq!(drain(&work), 1);
        assert_eq!(writes.get(), 0, "once-only: no second write");
    }

    #[test]
    fn watchdog_failure_releases_the_latch_for_another_path() {
        let work = Collector::default();
        let latch = Rc::new(Cell::new(false));
        let _watch = watch_with(&work, async {}, latch.clone(), || async {
            Err("database_unavailable".to_owned())
        });
        drain(&work);
        assert!(!latch.get());
    }

    #[test]
    fn watchdog_waits_for_the_deadline_plus_grace_and_never_less_than_grace() {
        assert_eq!(watchdog_delay_ms(30_000.0, 10_000.0), 22_000.0);
        assert_eq!(watchdog_delay_ms(10_000.0, 30_000.0), WATCHDOG_GRACE_MS);
    }

    #[test]
    fn a_read_dropped_while_pending_is_reported_and_a_finished_read_is_bounded() {
        captured::take();
        let clock = StreamClock::start();
        let mut pulls = 0;

        PullScope::begin(clock, &mut pulls).end("chunk");
        PullScope::begin(clock, &mut pulls).end("chunk");
        for _ in 0..50 {
            PullScope::begin(clock, &mut pulls).end("chunk");
        }
        let lines = captured::take();
        assert_eq!(
            lines.len(),
            4,
            "only the first two reads are traced: {lines:?}"
        );

        drop(PullScope::begin(clock, &mut pulls));
        let lines = captured::take();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("inference_stream_trace:pull_dropped_pending:53@"));
    }
}
