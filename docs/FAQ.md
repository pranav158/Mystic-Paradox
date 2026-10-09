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

## When will a public server or launcher be available?

There is no planned release date; work is still in progress. In the meantime you can
[self-host the project](SELF_HOSTING.md) to play with friends or run your own server.

## Which game version do I need?

Dauntless **1.12.0** (`rel-1.12.0-Archon`, changelist `392819`) is the supported, self-hostable target;
build it from the [`dauntless-1.12.0`](https://github.com/pranav158/Mystic-Paradox/tree/dauntless-1.12.0)
tag. `main` is moving to **1.14.7**, the final release, one component at a time: the runtime and tools are
done, the backend, Director and launcher follow, and it is not a complete 1.14.7 setup yet
([progress](DAUNTLESS_1_14_7_PORT.md)). Other versions are not expected to work.

## How can I test the project, help with development, or contact you?

- **Bugs, feature requests and testing feedback:** open an issue on GitHub. Include the component,
  commit, configuration with secrets removed, reproduction steps and relevant logs.
- **Security problems:** report them privately — see [SECURITY.md](../SECURITY.md).
- **Discord:** `uwumystic`. Please add a short note to your friend request explaining why you are
  contacting me, so I can tell project requests apart from unrelated ones.

I do not provide support or hold project discussions on Reddit.
