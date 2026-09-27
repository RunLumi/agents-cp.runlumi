# Worker runtime evidence (trimmed from the full wrangler dev log)

## passkey ceremony requests
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (96ms)
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (61ms)
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (32ms)
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (32ms)
[wrangler:info] POST /api/v1/auth/passkey/login/start 422 Unprocessable Entity (181ms)
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (81ms)
[wrangler:info] POST /api/v1/auth/passkey/login/start 500 Internal Server Error (70ms)
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (74ms)
[wrangler:info] POST /api/v1/auth/passkey/login/start 500 Internal Server Error (55ms)
[wrangler:info] POST /api/v1/auth/passkey/signup/start 500 Internal Server Error (73ms)

## the panic (first occurrence, full Rust frame list)
[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mUncaught RuntimeError: unreachable[0m

      at lumi_agents_control_plane_api.wasm.std[5a6270b673d0c64d]::panicking::panic_with_hook (wasm://wasm/lumi_agents_control_plane_api.wasm-024ae6f2:wasm-function[2213]:0x4d476f)
      at lumi_agents_control_plane_api.wasm.core[ed718c3d60ebd546]::panicking::panic_fmt (wasm://wasm/lumi_agents_control_plane_api.wasm-024ae6f2:wasm-function[5367]:0x59cac6)
      at lumi_agents_control_plane_api.wasm.passkey_auth[a4d79e7ac9e8fc4]::types::now_secs (wasm://wasm/lumi_agents_control_plane_api.wasm-024ae6f2:wasm-function[5178]:0x594440)
      at lumi_agents_control_plane_api.wasm.<lumi_agents_control_plane_api[87d8ba594dec37d1]::adapters::webauthn::WebAuthnAdapter>::start_registration (wasm://wasm/lumi_agents_control_plane_api.wasm-024ae6f2:wasm-function[995]:0x3d5256)
      at lumi_agents_control_plane_api.wasm.<lumi_agents_control_plane_api[87d8ba594dec37d1]::routes::authenticators::passkey_signup_start as axum[7a045f93772125b0]::handler::Handler<(axum_core[8f13b42ff96d6883]::extract::private::ViaRequest, axum[7a045f93772125b0]::extract::state::State<alloc[508e33bd5656020b]::sync::Arc<lumi_agents_control_plane_api[87d8ba594dec37d1]::app::AppState>>, axum[7a045f93772125b0]::extension::Extension<lumi_agents_control_plane_api[87d8ba594dec37d1]::core::context::RequestContext>, axum[7a045f93772125b0]::json::Json<lumi_agents_control_plane_api[87d8ba594dec37d1]::routes::authenticators::PasskeySignupStartRequest>), alloc[508e33bd5656020b]::sync::Arc<lumi_agents_control_plane_api[87d8ba594dec37d1]::app::AppState>>>::call::{closure#0} (wasm://wasm/lumi_agents_control_plane_api.wasm-024ae6f2:wasm-function[626]:0x32d419)
      at lumi_agents_control_plane_api.wasm.<axum[7a045f93772125b0]::util::MapIntoResponseFuture<axum[7a045f93772125b0]::handler::future::IntoServiceFuture<core[ed718c3d60ebd546]::pin::Pin<alloc[508e33bd5656020b]::boxed::Box<dyn core[ed718c3d60ebd546]::future::future::Future<Output = http[e1105271f7c279e0]::response::Response<axum_core[8f13b42ff96d6883]::body::Body>> + core[ed718c3d60ebd546]::marker::Send>>>> as core[ed718c3d60ebd546]::future::future::Future>::poll (wasm://wasm/lumi_agents_control_plane_api.wasm-024ae6f2:wasm-function[4305]:0x56e7e3)

## distinct panicking frames seen across the session
passkey_auth[a4d79e7ac9e8fc4]::types::now_secs

occurrences of now_secs in the log: 20
500s returned: 20
