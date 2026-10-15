pub mod account;
pub mod auth;
pub mod install;
pub mod launch;
pub mod logs;
// [2026-10-15] The launcher notices: the announcement banner and tags, read anonymously from the official backend.
pub mod notices;
pub mod provenance;
pub mod servers;
#[cfg(test)]
pub(crate) mod test_support;
pub mod updates;
