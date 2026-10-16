# Mystic Paradox Privacy Policy

Version {{PRIVACY_VERSION}}

This policy explains what data Mystic Paradox collects, why, who sees it, how long we keep it, and your choices. It covers
the Mystic Paradox launcher, the Mystic Paradox servers at paradox.mysticfox.dev, and Paradox realms. Mystic Paradox is a
free community project run by MysticFox. Privacy and data requests: {{PRIVACY_EMAIL}}. Help with the game, bug
and abuse reports: {{SUPPORT_EMAIL}}.

It does **not** cover local servers that other people run (see section 6), or Discord and other services you choose to
use, which have their own policies.

## 1. What we collect

**Your account**
- Username, email address (if you sign up with email), and your password, stored only as a secure one-way hash (Argon2id).
  We never see or store your password itself.
- If you sign in with Discord: your Discord user ID, Discord username and avatar link. We ask Discord only for basic
  identity, not your email, friends or servers.
- Account ID, sign-up date, last sign-in, account status and roles, and which version of these documents you accepted.

**Your game data**
- Characters, inventory, loadouts, in-game currencies, progression, challenges, cooldowns, Slayer's Path, mastery, and the
  history of in-game transactions (what was granted or spent, when, and by which part of the game).
- Party and friends information, and chat needed to deliver messages. Our logs record that a message was sent and its
  size, not what it says.

**Your in-game activity**
- What you do in the game is recorded: when and how long you play, the hunts you join or host, the Behemoths you defeat, the
  rewards you get, what you spend in-game currency on, the challenges you claim and what you unlock. We use it to keep the
  game fair, to find exploits and cheating, to fix bugs and to understand how the server is used.

**Paradox realms and co-op**
- Which realms you belong to or host, realm bans, and which realm hub or hunt you are in.
- Who took part in each co-op hunt, and a record of what the host's game server saved for each player (used to check for
  cheating), including XP earned per hunt.
- Whether your connection went through the relay.
- If you host: your PC's free memory, number of CPU cores and CPU load, power-saver state, the launcher version, and
  fingerprints (hashes) of the game and Mystic Paradox files, so we can tell whether your PC can host and runs unmodified
  files.

**Integrity checks (Guard)**
- While you play, the launcher sends signed integrity summaries: the game's process ID and start time, how many modules
  are loaded plus a single fingerprint of that list, and counters such as unexpected modules, modified protected memory,
  and whether a debugger is attached.
- When a program file that is not part of Windows or the game is loaded into the game (for example an overlay or a
  recording tool), it also sends that file's name, the name of its publisher and a fingerprint (hash) of the file - never
  the folder it is in, and never a list of your other programs.
- These checks only record and report. They never close the game or stop you from playing; we use them to spot cheating
  and to improve the checks. No hardware IDs are sent.

**Technical data**
- Our servers log requests (what was requested, with passwords and codes removed, the result and timing) and account IDs
  for actions taken.
- Your IP address is used to deliver data to you and, briefly and in memory, to limit abuse such as password guessing. It
  also appears in a few security logs, for example chat connections.
- **Log files - testers only.** The launcher keeps logs of your recent sessions on your PC (section 10). We receive them only
  from tester accounts: our operators give tester access only to players who volunteer to help test. A tester who chooses
  "Upload last session" sends us that Play session's launcher and game logs (the launcher log, the session details and the
  game's log files). They include the tester's username, account ID, the folder path of the game install, and what the
  launcher and the game did during that session. Nothing is uploaded unless the tester presses the button.
- **Every other account:** log upload is switched off. The launcher does not offer it, our servers refuse it, and we never
  collect your launcher or game log files.

**What we do not collect**
- No real names, dates of birth, home addresses, phone numbers or payment details.
- No precise location.
- No advertising or analytics trackers.
- No launcher or game log files from players without tester access.

## 2. Why we use it

- **To run the service** you signed up for: accounts, sign-in, saving your progress, matchmaking, realms and co-op hunts.
- **To keep it fair and safe**: preventing cheating, exploits, abuse and attacks, enforcing the Terms of Use, and fixing
  bugs.
- **To meet legal obligations**, and to answer requests from you.

We do not sell your data, and we do not use it for advertising.

## 3. Who sees it

- **Other players** see your username and what the game normally shows (your character, gear, progress in a party).
- **Realm hosts** see who is in their realm, where (Ramsgate, Training or a hunt), how each player is connected, and they
  can kick or ban players from their realm. Their PC runs the realm's game servers, so game data for that session passes
  through it.
- **Cloudflare** relays co-op game traffic between players. It handles the IP addresses of the connected players and a
  pseudonymous identifier (not your account ID) we use to count relay usage.
- **Our operators** (the people who run Mystic Paradox) can read the logs a tester uploads, to find and fix problems. Every
  read and every deletion of an upload is recorded in our audit log. This applies to tester accounts only.
- **Discord**, if you choose to sign in with Discord.
- **Our hosting provider**, which runs our servers.
- **Authorities**, if the law requires it.

**Your IP address in co-op:** realm and co-op traffic goes through Cloudflare's relay, so other players and hosts see a
relay address, not your IP address. Cloudflare and our servers do see it, as any online service does. (Local servers are
different: see section 6.)

## 4. Where it is stored

Our servers are in India. Cloudflare's relay network is worldwide, so relayed traffic may pass through other countries.

## 5. How long we keep it

- **Account and game data:** while your account exists.
- **Deleting your account:** request it on the launcher's Account page. Your account is **deactivated at once** (you
  cannot play) and held for **30 days**, during which you can sign in and restore it. After 30 days we delete your
  account, game data, realm data and integrity records.
- **After deletion we keep only a minimal record:** that an account was deleted and when, under a pseudonymous ID. If the
  account was banned, we also keep what we need to enforce the ban, such as a one-way hash of the email address and the
  reason.
- **Activity statistics:** daily summaries of your activity are kept for up to 400 days; the detailed records stay while
  your account exists.
- **Integrity check data** is kept for up to 90 days.
- **Server logs** are kept for up to 90 days and then deleted. Sign-in sessions expire on their own.
- **Tester log uploads** (tester accounts only) are kept for 90 days after a session's last upload and then deleted
  automatically. A tester can ask us to delete them sooner.

## 6. Local servers

When you add a local server, you send your data to whoever runs it, not to us. Its operator can see your IP address and
everything that server stores. We do not run or check local servers; read their own terms and privacy information.

## 7. Your rights

Depending on where you live, you can ask to see, correct, export or delete your data, object to how we use it, or
withdraw consent. Delete your account in the launcher, or email {{PRIVACY_EMAIL}} for anything else. We answer within 30
days. You can also complain to your data protection authority.

## 8. Age

Mystic Paradox is for people aged **{{MINIMUM_AGE}} or older**. We do not knowingly collect data from anyone younger; if
we learn that we have, we delete it.

## 9. Security

- Connections to our servers are encrypted (HTTPS).
- Passwords are hashed with Argon2id.
- Your sign-in is stored on your PC in Windows Credential Manager or encrypted with Windows' own protection.
- Access to our servers and admin tools is restricted.

No system is perfectly secure; tell us at {{SUPPORT_EMAIL}} if you find a
security problem.

## 10. Data on your PC

The launcher stores your settings, your saved sign-in (as above), the servers you added, and logs of your recent sessions
in `%LOCALAPPDATA%\MysticParadox\Logs`. These logs stay on your PC: they are sent to us only if your account has tester
access and you press "Upload last session" (section 1). It uses no cookies or trackers. You can remove all of it by uninstalling the
launcher and deleting those folders.

## 11. Changes

We may update this policy. When we change it in a meaningful way, the launcher will ask you to accept the new version.
The version date is at the top.
