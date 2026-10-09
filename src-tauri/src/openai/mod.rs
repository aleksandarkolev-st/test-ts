pub mod auth;
pub mod client;
pub mod codex;
pub mod prompts;
pub mod timing;
pub mod responses_ws;
pub mod realtime;

pub fn acceptance_mode() -> bool {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    {
        return std::env::var("COPILOT_ACCEPTANCE").as_deref() == Ok("1");
    }
    #[cfg(not(all(feature = "acceptance", debug_assertions)))]
    false
}

// Instrumented native runs can exercise either a local HTTP fixture or the
// actual signed-in Codex service. Injection alone must not fake authentication.
pub fn http_fixture_mode() -> bool {
    acceptance_mode() && std::env::var_os("COPILOT_TEST_API").is_some()
}
