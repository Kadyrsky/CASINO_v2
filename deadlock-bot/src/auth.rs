//! Steam login. The password is used once, by `login`, to get a refresh token; every other
//! command logs in with that saved token, so the password is never stored.

use std::path::PathBuf;

use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use steam_vent::auth::{
    AuthConfirmationHandler as _, ConsoleAuthConfirmationHandler, DeviceConfirmationHandler,
    FileGuardDataStore,
};
use steam_vent::{Connection, ServerList};

/// There is no saved login on this computer yet.
#[derive(Debug)]
pub struct NotLoggedIn;

impl std::fmt::Display for NotLoggedIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("not logged in yet: run `deadlock-bot login --username <steam login>` first")
    }
}

impl std::error::Error for NotLoggedIn {}

#[derive(Serialize, Deserialize)]
struct SavedLogin {
    account_name: String,
    refresh_token: String,
}

/// Folder for the saved login and the request log. `DEADLOCK_BOT_HOME` overrides it.
pub fn state_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("DEADLOCK_BOT_HOME") {
        return Ok(PathBuf::from(dir));
    }
    let dirs = ProjectDirs::from("", "naebka", "deadlock-bot")
        .context("could not find a home folder for the saved login")?;
    Ok(dirs.config_dir().to_path_buf())
}

fn login_file() -> Result<PathBuf> {
    Ok(state_dir()?.join("login.json"))
}

/// Logs in with a password and Steam Guard, then saves the refresh token.
pub async fn login(username: &str) -> Result<()> {
    let password = match std::env::var("STEAM_PASSWORD") {
        Ok(password) if !password.is_empty() => password,
        _ => rpassword::prompt_password(format!("Steam password for {username}: "))
            .context("could not read the password")?,
    };

    let dir = state_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    let guard_store = FileGuardDataStore::new(dir.join("machine_tokens.json"));

    let servers = ServerList::discover()
        .await
        .context("could not reach Steam")?;
    eprintln!(
        "Logging in as {username}. If Steam asks, approve the login in the Steam mobile app \
         or type the Steam Guard code here."
    );
    let conn = Connection::login(
        &servers,
        username,
        &password,
        guard_store,
        ConsoleAuthConfirmationHandler::default().or(DeviceConfirmationHandler),
    )
    .await
    .context("Steam login failed")?;

    // After a password login steam-vent keeps the refresh token as the session's access token.
    let refresh_token = conn
        .access_token()
        .context("Steam did not return a login token")?
        .to_owned();
    save(&SavedLogin {
        account_name: username.to_owned(),
        refresh_token,
    })
}

/// Deletes the saved login. Returns false when there was none.
pub fn logout() -> Result<bool> {
    let path = login_file()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).with_context(|| format!("could not delete {}", path.display())),
    }
}

/// Whether a login token is saved on this computer.
pub fn has_saved_login() -> bool {
    login_file().is_ok_and(|path| path.exists())
}

/// Opens a Steam session with the saved token.
pub async fn connect() -> Result<Connection> {
    let path = login_file()?;
    let saved: SavedLogin = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("{} is not a valid saved login", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(NotLoggedIn.into()),
        Err(e) => return Err(e).with_context(|| format!("could not read {}", path.display())),
    };

    let servers = ServerList::discover()
        .await
        .context("could not reach Steam")?;
    Connection::access(&servers, &saved.account_name, &saved.refresh_token)
        .await
        .context("Steam refused the saved login; run `deadlock-bot login` again")
}

fn save(login: &SavedLogin) -> Result<()> {
    let path = login_file()?;
    let json = serde_json::to_vec_pretty(login)?;
    write_private(&path, &json).with_context(|| format!("could not write {}", path.display()))
}

/// Writes a file only the current user can read: the token is as powerful as a password.
#[cfg(unix)]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // `mode` only applies to new files, so tighten an older one too.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)
}

/// On Windows the file sits in the user's own AppData folder, which other users cannot read.
#[cfg(not(unix))]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}
