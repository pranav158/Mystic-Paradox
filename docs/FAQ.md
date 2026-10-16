# Frequently asked questions

Answers to the questions I receive most often about Mystic Paradox.

## Can you add the game files and generated SDK files to the repository?

No. The game files and generated SDK files contain intellectual property belonging to Phoenix Labs
and/or Forte Labs. I cannot upload, distribute or provide them. You must obtain the required game
files lawfully and generate the SDK from your own compatible installation by following
[Generating the SDK](GENERATING_SDK.md) and [Generating game data](GENERATING_GAME_DATA.md).

## Why is development slow? Have you stopped working on the project?

No, I have not abandoned the project. Development is slow because my job and personal schedule leave
me limited time to work on it. Current progress on the Dauntless 1.14.7 port is in
[DAUNTLESS_1_14_7_PORT.md](DAUNTLESS_1_14_7_PORT.md).

## Is there a public server or launcher?

Yes, as a **closed beta test**. The launcher on the
[Releases](https://github.com/pranav158/Mystic-Paradox/releases) page connects to the official server, which is
open to invited testers only: a new account stays pending until it is approved, and a pending account cannot
sign in or play. To request access, [join our Discord server](https://discord.gg/e3HuAZGdU3) and ask there.
Please create one account and wait for it; more accounts do not get approved any sooner.

There is no date yet for an open release. In the meantime you can [self-host the project](SELF_HOSTING.md) to
play with friends or run your own server.

## Which game version do I need?

`main` targets Dauntless **1.14.7** (`rel-1.14.7-Archon`, changelist `647472`), the final release. Every
component is ported, the official server runs it as a closed beta, and the self-hosting guides describe it
([progress](DAUNTLESS_1_14_7_PORT.md)). Dauntless **1.12.0** (changelist `392819`) is a legacy alpha that is no
longer updated; it builds from the
[`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag. Other versions are
not expected to work.

If Dauntless is in your Epic Games library, [Installing Dauntless](INSTALLING_DAUNTLESS.md) shows how to download
1.14.7 from Epic with your own account. Epic itself now only offers 2.1.1, which is not supported.

## How can I test the project, help with development, or contact you?

- **Bugs, feature requests and testing feedback:** open an issue on GitHub. Include the component,
  commit, configuration with secrets removed, reproduction steps and relevant logs.
- **Security problems:** report them privately — see [SECURITY.md](../SECURITY.md).
- **Discord:** [join our server](https://discord.gg/e3HuAZGdU3) for beta access, announcements and help. You
  can also add me, `uwumystic`; please add a short note to your friend request explaining why you are
  contacting me, so I can tell project requests apart from unrelated ones.

I do not provide support or hold project discussions on Reddit.
