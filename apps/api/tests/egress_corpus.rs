//! One SSRF bypass corpus, run against every egress validator in the crate.
//!
//! Every input here was actually tried against the running code during the
//! P09-SEC-03 audit. A bypass that is described in a comment and not encoded
//! here comes back, so this file is the deliverable and the report is the
//! summary.
//!
//! Three surfaces take a caller-influenceable host:
//!
//! | surface | validator | what it is |
//! |---|---|---|
//! | webhook delivery | `adapters::webhooks::outbound::validate_endpoint_url` | a real fetch guard: range + reserved-name, no allowlist, DNS re-checked immediately before every connection |
//! | provider + MCP endpoint | `adapters::providers::validate_endpoint_url` | a real fetch guard: operator-owned exact-host allowlist, plus the same range check as an independent second layer |
//! | plugin destinations | `modules::plugins::PluginPermissionManifest::rejects_destination` | NOT a fetch guard. Nothing dials a recorded declaration, so it filters what the platform is willing to *record*, review, and diff. |
//!
//! That last distinction is why the corpus is split in two. Everything in
//! [`BLOCKED`] must be refused by all three. Everything in
//! [`DECLARATION_FILTER_GAPS`] must be refused by both fetch guards and is
//! recorded here as NOT refused by the declaration filter — a coverage
//! statement, asserted in both directions so it cannot drift unnoticed in
//! either.
//!
//! # The poisoned allowlist
//!
//! The provider validator is checked twice per input:
//!
//! * with an empty allowlist it must refuse everything. That is the
//!   fail-closed default, and on its own it proves nothing about the range
//!   check — every case would pass.
//! * with an allowlist containing exactly the host this URL connects to it
//!   must STILL refuse. That models the realistic failure: an operator
//!   allowlists a host a tenant asked for, and the range check has to hold the
//!   line on its own.
//!
//! [`ALLOWED`] runs the same way and must be accepted, so a corpus that passes
//! because everything is refused is visible as such.

use std::fs;
use std::path::{Path, PathBuf};

use lumi_agents_control_plane_api::adapters::providers::{self, SsrfError};
use lumi_agents_control_plane_api::adapters::webhooks::outbound;
use lumi_agents_control_plane_api::modules::plugins::PluginPermissionManifest;

/// A destination no surface may reach: loopback, RFC1918, link-local, cloud
/// metadata, a split-horizon name, or a URL that cannot be one.
///
/// All three surfaces refuse every entry.
const BLOCKED: &[&str] = &[
    // -- loopback -----------------------------------------------------------
    "https://127.0.0.1/v1",
    "http://127.0.0.1:8787",     // plaintext loopback
    "https://127.0.0.1:8443/v1", // loopback on an allowed port
    "https://127.0.0.1:22/v1",   // loopback port scan
    "https://[::1]/v1",
    "https://[::1]:8443/v1",
    // -- RFC1918, link-local, metadata --------------------------------------
    "https://10.0.0.5/v1",
    "https://172.16.4.4/v1",
    "https://192.168.1.1/v1",
    "https://169.254.169.254/v1", // AWS/Azure/GCP metadata
    "https://[fe80::1]/v1",       // IPv6 link-local
    "https://[fc00::1]/v1",       // IPv6 unique-local
    "https://[fd12:3456:789a::1]/v1",
    // -- split-horizon names a resolver cannot be trusted to map outward ----
    "https://localhost:8080/hook",
    "https://api.localhost/hook",
    "https://printer.local/hook",
    // -- authority confusion ------------------------------------------------
    "  https://127.0.0.1/v1  ", // padded
    // -- schemes that are not https ----------------------------------------
    "file:///etc/passwd",
    "gopher://127.0.0.1:11211/",
    "dict://127.0.0.1:11211/",
    "ftp://127.0.0.1/v1",
    "data:text/plain;base64,aGk=",
    "javascript:alert(1)",
];

/// Destinations that must keep working, so a corpus that refuses everything is
/// not mistaken for a passing corpus.
const ALLOWED: &[&str] = &[
    "https://api.example.com/v1",
    "https://api.example.com:8443/v1",
    "https://api.example.com./v1", // a legal FQDN with a root label
    "https://sub.api.example.com/v1",
    "https://[2606:4700::1111]/v1", // a globally routable IPv6 literal
    "https://xn--e1afmkfd.xn--p1ai/v1", // a punycoded IDN host
];

/// Destinations both fetch guards refuse and the plugin declaration filter
/// does not.
///
/// The declaration filter never dials anything, so none of these is a live
/// SSRF; the consequence is audit visibility — a manifest that declares
/// `http://0177.0.0.1` is recorded, diffed, and shown to a reviewer as a
/// permitted public destination. It is a narrower, differently-spelled
/// predicate than the two fetch guards, and this list is the precise statement
/// of where it is narrower.
///
/// The P07 handoff recorded two of these: `.internal` not being in the name
/// list, and a `*.suffix` pattern rooted at a three-octet string counting as a
/// hostname. The rest share their root cause — the filter splits the string by
/// hand and hands it to `Ipv4Addr`/`Ipv6Addr::from_str`, neither of which
/// understands WHATWG host normalization, so every alternate spelling of an
/// address reads as an ordinary name. `modules::plugins` is left unchanged
/// here: closing these is a change to a reviewed P07 surface and a frozen
/// fixture, and it is a coordinator decision, not an audit finding to slip in.
const DECLARATION_FILTER_GAPS: &[&str] = &[
    // Alternate IPv4 spellings. WHATWG parsing folds every one of these to
    // 127.0.0.1 before a connection is made; `Ipv4Addr::from_str` folds none
    // of them, so the filter reads a name.
    "https://127.1/v1",        // short form
    "https://0177.0.0.1/v1",   // octal
    "https://0x7f.0.0.1/v1",   // hex
    "https://2130706433/v1",   // decimal
    "https://017700000001/v1", // octal, single component
    "https://127.0.0.1./v1",   // trailing root label
    "https://①②⑦.0.0.1/v1",    // IDN digits fold to ASCII digits
    // IPv4-mapped and IPv4-compatible IPv6, whose low 32 bits carry the target
    // and which are not themselves loopback, unspecified, or unique-local.
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::127.0.0.1]/v1",
    "https://[::ffff:0:0]/v1",
    "https://[::ffff:169.254.169.254]/v1",
    "https://[64:ff9b::7f00:1]/v1", // NAT64 well-known prefix
    "https://[::]/v1",              // unspecified
    // Ranges outside the filter's three predicates, which are private, loopback,
    // and link-local only: unspecified, "this network", CGNAT, IETF protocol
    // assignments, 6to4 relay anycast, benchmarking, TEST-NET, multicast, and
    // the reserved top of the space.
    "https://0.0.0.0/v1",
    "https://0.1.2.3/v1",
    "https://100.64.0.1/v1",
    "https://192.0.0.1/v1",
    "https://192.88.99.1/v1",
    "https://192.0.2.5/v1",
    "https://198.18.0.1/v1",
    "https://203.0.113.5/v1",
    "https://224.0.0.1/v1",
    "https://255.255.255.255/v1",
    "https://169.254.169.254./v1", // metadata behind a trailing root label
    // Split-horizon names outside the filter's four entries, which are `local`,
    // `localhost`, `.localhost`, and `.local`. `.internal` is the P07-recorded
    // one; the rest are the same omission.
    "https://metadata.google.internal/v1",
    "https://db.internal/v1",
    "https://x.internal/v1",
    "https://host.home.arpa/v1",
    "https://duskgytldkxiuqc6.onion/v1",
    "https://1.0.0.127.in-addr.arpa/v1",
    // Authority confusion. The filter reads the host by hand-splitting, so a
    // userinfo, a fragment, or a control character turns the real host into a
    // name. Every one of these connects to 127.0.0.1 or fails to parse.
    "http://allowed.example.com@127.0.0.1/",
    "https://user:pass@127.0.0.1/",
    "https://allowed.example.com@127.0.0.1:8443/",
    "https://127.0.0.1#@allowed.example.com/",
    "https://allowed.example.com%40127.0.0.1/",
    "https://127.0.0.1\t/v1",
    "https://127.0.0.1\n/v1",
    "https://[::1", // unterminated bracket
    // A host that is not a syntactically valid DNS name, and a port out of
    // range. Out of scope for a declaration filter by design.
    "https://exa_mple.com/",
    "https://allowed.example.com:99999/v1",
    // A `*.suffix` pattern rooted at a three-octet string: the recorded P07 gap.
    "*.0.0.1",
];

/// An operator who allowlisted exactly the host this URL connects to.
///
/// Built with the same parser the transport uses and trimmed the way both
/// validators trim, so the entry is the host that will actually be dialled.
/// That is the only way to test the range check as an independent barrier
/// rather than as a shadow of the allowlist.
fn poisoned_allowlist(input: &str) -> Vec<String> {
    url::Url::parse(input)
        .ok()
        .and_then(|parsed| {
            parsed.host_str().map(|host| {
                let host = host.trim_end_matches('.');
                host.strip_prefix('[')
                    .and_then(|inner| inner.strip_suffix(']'))
                    .unwrap_or(host)
                    .to_ascii_lowercase()
            })
        })
        .into_iter()
        .collect()
}

fn providers_accepts(input: &str, allowlist: &[String], local: bool) -> bool {
    providers::validate_endpoint_url(input, allowlist, local).is_ok()
}

#[test]
fn the_webhook_guard_refuses_every_blocked_destination() {
    for input in BLOCKED {
        assert!(
            outbound::validate_endpoint_url(input).is_err(),
            "webhook delivery accepted {input:?}"
        );
    }
}

#[test]
fn the_provider_and_mcp_guard_refuses_every_blocked_destination() {
    for input in BLOCKED {
        assert!(
            !providers_accepts(input, &[], false),
            "an empty allowlist accepted {input:?}"
        );
        assert!(
            !providers_accepts(input, &poisoned_allowlist(input), false),
            "a poisoned allowlist accepted {input:?}"
        );
    }
}

#[test]
fn the_plugin_declaration_filter_refuses_every_blocked_destination() {
    for input in BLOCKED {
        assert!(
            PluginPermissionManifest::rejects_destination(input),
            "the plugin manifest recorded a declaration of {input:?}"
        );
    }
}

/// A range check that is really the allowlist in disguise passes this corpus
/// without testing anything. The poisoned-allowlist cases are what catch that;
/// these are what those cases are protecting.
#[test]
fn the_corpus_is_not_vacuous_because_legitimate_destinations_still_work() {
    for input in ALLOWED {
        assert!(
            outbound::validate_endpoint_url(input).is_ok(),
            "webhook delivery refused the legitimate {input:?}"
        );
        assert!(
            providers_accepts(input, &poisoned_allowlist(input), false),
            "the provider guard refused the legitimate {input:?}"
        );
        assert!(
            !PluginPermissionManifest::rejects_destination(input),
            "the plugin filter refused the legitimate {input:?}"
        );
    }
}

/// The declaration filter's coverage, asserted in both directions.
///
/// Asserting only the "not refused" half would let the filter silently tighten
/// and hide a divergence the coordinator has not been told about; asserting
/// only the "refused" half would be a change request smuggled in as a test.
#[test]
fn the_declaration_filter_gaps_are_refused_on_both_fetch_paths() {
    for input in DECLARATION_FILTER_GAPS {
        assert!(
            outbound::validate_endpoint_url(input).is_err(),
            "webhook delivery accepted {input:?}"
        );
        assert!(
            !providers_accepts(input, &poisoned_allowlist(input), false),
            "a poisoned allowlist let the provider guard accept {input:?}"
        );
        assert!(
            !PluginPermissionManifest::rejects_destination(input),
            "the declaration filter started refusing {input:?}; that is a change to a P07 surface and needs a change request"
        );
    }
}

/// The reason code has to distinguish "you may not have this host" from "this
/// host is not allowed here": only the second is fixed by configuration and the
/// first never is.
#[test]
fn a_private_destination_is_refused_before_the_allowlist_is_consulted() {
    for (input, expected) in [
        ("https://127.0.0.1/v1", SsrfError::PrivateDestination),
        (
            "https://[::ffff:127.0.0.1]/v1",
            SsrfError::PrivateDestination,
        ),
        ("https://169.254.169.254/v1", SsrfError::PrivateDestination),
        (
            "https://metadata.google.internal/v1",
            SsrfError::PrivateDestination,
        ),
    ] {
        assert_eq!(
            providers::validate_endpoint_url(input, &poisoned_allowlist(input), false),
            Err(expected),
            "wrong reason for {input:?}"
        );
    }
    // An ordinary public host is refused for the other reason, and is accepted
    // once it is configured. That is the whole point of keeping the two apart.
    assert_eq!(
        providers::validate_endpoint_url("https://api.example.com/v1", &[], false),
        Err(SsrfError::HostNotAllowlisted)
    );
}

#[test]
fn userinfo_in_a_provider_endpoint_is_refused_as_credentials() {
    // The credential half of the reason is what makes this a distinct class:
    // the caller put something secret-shaped into a URL that gets persisted
    // and may reach a log.
    assert_eq!(
        providers::validate_endpoint_url("https://user:pass@127.0.0.1/v1", &[], false),
        Err(SsrfError::CredentialsNotAllowed)
    );
    assert!(
        SsrfError::CredentialsNotAllowed
            .to_string()
            .contains("credentials")
    );
}

#[test]
fn an_empty_allowlist_refuses_every_provider_endpoint() {
    for input in ALLOWED {
        assert_eq!(
            providers::validate_endpoint_url(input, &[], false),
            Err(SsrfError::HostNotAllowlisted),
            "an empty allowlist accepted {input:?}"
        );
    }
    // A wildcard in configuration is not a wildcard: exact-host matching means
    // `*` and `*.example.com` are just hosts nobody configured.
    for entry in ["*", "*.example.com", "example.com:8443", "xample.com"] {
        assert_eq!(
            providers::validate_endpoint_url(
                "https://api.example.com/v1",
                &[entry.to_owned()],
                false
            ),
            Err(SsrfError::HostNotAllowlisted),
            "the allowlist entry {entry:?} matched"
        );
    }
    // Case folding is ASCII-only and the whole host must match.
    assert!(providers_accepts(
        "https://API.Example.COM/v1",
        &["api.example.com".to_owned()],
        false
    ));
    assert!(!providers_accepts(
        "https://evil-api.example.com/v1",
        &["api.example.com".to_owned()],
        false
    ));
}

#[test]
fn the_local_development_escape_hatch_is_scoped_to_development() {
    // `allow_local_development` is `ENVIRONMENT == "development"` and nothing
    // else. It exists so a developer can point the gateway at a local mock
    // server, and it is the one path that skips the range check — so the only
    // thing standing between it and production is that assignment in app.rs.
    assert!(providers_accepts(
        "http://127.0.0.1:8787/v1",
        &["127.0.0.1".to_owned()],
        true
    ));
    assert!(!providers_accepts(
        "http://127.0.0.1:8787/v1",
        &["127.0.0.1".to_owned()],
        false
    ));
    // Skipping the range check does not become a scheme wildcard, and the
    // allowlist still applies in development.
    assert!(!providers_accepts("file:///etc/passwd", &[], true));
    assert!(!providers_accepts("https://169.254.169.254/v1", &[], true));
    // The mock fixtures are development-only and are a fixed, closed set.
    assert!(providers_accepts("mock://lumi-success", &[], true));
    for fixture in [
        "mock://evil",
        "mock://lumi-success/../../etc/passwd",
        "mock://",
        "mock://lumi-fail-extra",
    ] {
        assert_eq!(
            providers::validate_endpoint_url(fixture, &[], true),
            Err(SsrfError::SchemeNotAllowed),
            "the development mock set accepted {fixture:?}"
        );
    }
    assert_eq!(
        providers::validate_endpoint_url("mock://lumi-success", &[], false),
        Err(SsrfError::SchemeNotAllowed),
        "a mock fixture was reachable outside development"
    );
}

/// A name that resolves inward is the one case a validator cannot catch alone.
///
/// `127.0.0.1.example.com` is a syntactically perfect public hostname, and
/// wildcard DNS services will answer it with 127.0.0.1. Refusing every name
/// that could resolve to anything would mean refusing the internet, so the
/// webhook path resolves and re-checks instead. The pairing is the control:
/// accepted structurally, refused the moment an address is known.
#[test]
fn a_name_that_resolves_inward_is_refused_at_resolution_not_at_registration() {
    let inward = "https://127.0.0.1.example.com/hook";
    let endpoint = outbound::validate_endpoint_url(inward).expect("a public name is valid");
    let resolved: Vec<std::net::IpAddr> = vec!["127.0.0.1".parse().unwrap()];
    assert_eq!(
        outbound::validate_resolved_addresses(&endpoint, &resolved).unwrap_err(),
        outbound::SsrfRejection::UrlBlocked
    );
    // An empty answer fails closed rather than connecting blind.
    assert_eq!(
        outbound::validate_resolved_addresses(&endpoint, &[]).unwrap_err(),
        outbound::SsrfRejection::DnsUnavailable
    );
    // A mixed answer fails the whole attempt, so a name that hands back one
    // public and one private address cannot be used to reach the private one.
    assert_eq!(
        outbound::validate_resolved_addresses(
            &endpoint,
            &[
                "93.184.216.34".parse().unwrap(),
                "10.0.0.5".parse().unwrap()
            ]
        )
        .unwrap_err(),
        outbound::SsrfRejection::UrlBlocked
    );
    // On the provider path there is no resolver, so the operator allowlist is
    // the only barrier. That is why an empty allowlist has to refuse: a
    // wildcard-DNS name is a name, and no range table can see through it.
    assert_eq!(
        providers::validate_endpoint_url(inward, &[], false),
        Err(SsrfError::HostNotAllowlisted)
    );
}

/// Every outbound request must be constructed with redirects disabled.
///
/// `worker`'s `fetch` follows redirects by default, so a validator that only
/// inspects the initial URL is decorative: a 302 to `169.254.169.254` reaches
/// the metadata service with the request intact, signature headers and all.
/// `RequestRedirect::Error` maps to `redirect: "error"`, which surfaces a 3xx
/// as a fetch failure instead of a followed hop.
///
/// The check is structural because the behaviour is not observable from a host
/// test — it lives in the Workers runtime. A count comparison is enough to
/// catch the regression this protects against: a new outbound request that
/// forgets the line.
#[test]
fn no_outbound_request_is_constructed_without_redirects_disabled() {
    let mut requests = 0_usize;
    let mut disabled = 0_usize;
    let mut followed = 0_usize;
    for (name, body) in rust_sources() {
        requests += body.matches("RequestInit::new()").count();
        disabled += body
            .matches("with_redirect(RequestRedirect::Error)")
            .count();
        followed += body.matches("RequestRedirect::Follow").count()
            + body.matches("RequestRedirect::Manual").count();
        assert!(
            !body.contains("redirect: \"follow\""),
            "{name} asks the runtime to follow redirects"
        );
    }
    assert!(
        requests > 0,
        "the scan found no outbound request at all, so it is not looking"
    );
    assert_eq!(
        requests, disabled,
        "every RequestInit must set RequestRedirect::Error"
    );
    assert_eq!(
        followed, 0,
        "RequestRedirect::Follow or ::Manual reintroduces redirect following"
    );
}

fn rust_sources() -> Vec<(String, String)> {
    fn walk(directory: &Path, found: &mut Vec<(String, String)>) {
        for entry in fs::read_dir(directory).expect("a readable source directory") {
            let path = entry.expect("a readable entry").path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.extension().is_some_and(|value| value == "rs") {
                found.push((
                    path.display().to_string(),
                    fs::read_to_string(&path).expect("a readable source file"),
                ));
            }
        }
    }
    let mut found = Vec::new();
    walk(&crate_root().join("src"), &mut found);
    found
}

fn crate_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}
