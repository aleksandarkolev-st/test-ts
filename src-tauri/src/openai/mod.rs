pub mod auth;
pub mod client;
pub mod codex;
pub mod prompts;
pub mod timing;

pub fn acceptance_mode() -> bool {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    {
        return std::env::var("COPILOT_ACCEPTANCE").as_deref() == Ok("1");
    }
    #[cfg(not(all(feature = "acceptance", debug_assertions)))]
    false
}
