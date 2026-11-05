# Frequently asked questions

Answers to the questions I receive most often about Mystic Paradox.

## Can you add the game files and generated SDK files to the repository?

No. The game files and generated SDK files contain intellectual property belonging to Phoenix Labs
and/or Forte Labs. I cannot upload, distribute or provide them. You must obtain the required game
files lawfully and generate the SDK from your own compatible installation by following
[Generating the SDK](GENERATING_SDK.md) and [Generating game data](GENERATING_GAME_DATA.md).

## Is the project still being worked on?

Yes. Mystic Paradox gets updates most weeks: fixes, new features and events. The launcher installs them by
itself, and news and changelogs are posted on our [Discord server](https://discord.gg/e3HuAZGdU3). How the final release was
ported is in [DAUNTLESS_1_14_7_PORT.md](DAUNTLESS_1_14_7_PORT.md).

## Is there a public server or launcher?

Yes. Download the launcher from the [Releases](https://github.com/pranav158/Mystic-Paradox/releases) page, create
an account in it and press Play: it connects to the official Mystic Paradox server and keeps itself and the game's
runtime up to date. You need your own Dauntless 1.14.7 install ([Installing Dauntless](INSTALLING_DAUNTLESS.md)).
News and help are on our [Discord server](https://discord.gg/e3HuAZGdU3).

You can also [self-host the project](SELF_HOSTING.md) to play with friends or run your own server.

## Which game version do I need?

`main` targets Dauntless **1.14.7** (`rel-1.14.7-Archon`, changelist `647472`), the final release. Every
component is ported, the official server runs it, and the self-hosting guides describe it
([progress](DAUNTLESS_1_14_7_PORT.md)). Dauntless **1.12.0** (changelist `392819`) is a legacy version that is no
longer updated; it builds from the
[`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0) tag. Other versions are
not expected to work.

If Dauntless is in your Epic Games library, [Installing Dauntless](INSTALLING_DAUNTLESS.md) shows how to download
1.14.7 from Epic with your own account. Epic itself now only offers 2.1.1, which is not supported.

## How can I help with development or contact you?

- **Bugs and feature requests:** open an issue on GitHub. Include the component, commit,
  configuration with secrets removed, reproduction steps and relevant logs.
- **Security problems:** report them privately — see [SECURITY.md](../SECURITY.md).
- **Discord:** [join our server](https://discord.gg/e3HuAZGdU3) for help, announcements and news. You
  can also add me, `uwumystic`; please add a short note to your friend request explaining why you are
  contacting me, so I can tell project requests apart from unrelated ones.

I do not provide support or hold project discussions on Reddit.
