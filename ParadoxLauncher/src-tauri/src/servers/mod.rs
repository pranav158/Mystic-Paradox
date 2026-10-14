// [2026-10-13 realms S1] Multi-server launcher: the server list (`model`: pure data and validation, `store`: the
// file and "which server is the launcher working on"). Commands are in `commands/servers.rs`.
// [2026-10-13 realms S5] `network`: which calls belong to our network, per kind of server.
pub mod model;
pub mod network;
// [2026-10-14 realms] The joiner's presence loop for a realm game (`realm_presence::start` / `client_exited`).
pub mod realm_presence;
// [2026-10-14 realms] The realm directory lookup: a realm's host key, and whether its name changed hands.
pub mod realm_directory;
pub mod store;

pub use model::{
    is_official_backend_address, normalize_backend_url, FolderSource, NewServer, ServerEntry,
    ServerKind, OFFICIAL_ID,
};
pub use network::play_block_reason;
pub use store::{
    active_target, all_targets, new_server_id, set_game_exe, target_for, ServerTarget,
};
