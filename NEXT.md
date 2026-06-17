# Agee: Next Direction

## What This Is

Agee should start as an open source browser-native interface shell.

The immediate product is a browser extension with a small on-page surface that can be invoked by click or keyboard shortcut, then used through typing or speech. It should feel like a personal interface to agents, not a sidebar, not a separate browser agent, and not another silo.

The larger direction is a user-owned software layer: something people can inspect, modify, self-host, extend, and eventually run across browser, desktop, mobile, and local machines.

## Core Belief

Intelligence is personal.

The information flowing through an agent is intimate: browser state, work context, identity, credentials, intent, memory, and decisions. The user should own that layer. The product should not trap people inside a hosted silo.

Open source is not a side detail. It is part of the product promise:

- You own the code.
- You can run it yourself.
- You can modify it.
- You can replace the hosted version with a local version.
- You can build apps and workflows inside the system instead of waiting for the vendor.

The business has to work without lock-in.

## Why Browser First

The browser is the best first surface because it is where the user's work already lives.

It already contains SaaS tools, docs, email, dashboards, admin panels, research, forms, and apps. A browser extension can place a lightweight interface directly on the current site and, when explicitly asked, experiment with page-aware actions.

Browser first also solves distribution. Anyone can install an extension. It avoids the early complexity of building a full Mac app, Windows app, mobile app, and local runtime before there is proof that people want the interface.

The extension should be the first shell. The core infrastructure underneath should be designed so the same agent layer can later plug into Moa, desktop, mobile, or a local machine.

## Product Shape

Start with a Chrome extension.

It should have two primary interaction modes:

- Voice mode: speak naturally and have the agent act in the browser.
- Command mode: use a `Cmd+K` style interface to ask for actions, explanations, or workflows.

The first loop is interface-first: summon the surface, type or speak, see progress, and keep control. Model-backed actions are experimental capability, not the whole product identity.

The user should be able to bring their own API keys from the beginning. ElevenLabs can be used for voice initially, with the option to move toward local models later.

The first version should focus on the smallest loop that can be used and improved:

- Put a small on-page control somewhere the user can move.
- Open an overlay by click or shortcut.
- Accept typed and spoken input.
- Run on a controlled localhost development page while the extension reloads from code changes.
- Allow safe customization from inside the app.
- Keep the architecture open enough for userScripts and broader agent interfaces later.

## What Not To Build Yet

Do not start with the full cross-platform dream.

The eventual vision includes browser, Moa, Mac, Windows, Linux, mobile, local models, self-hosting, hosted service, app-building inside the app, and a software factory. That is the direction, but building all of it first will stall the project.

The next step is narrower:

> Prove that a user-owned browser interface is useful enough that people will try it, customize it, use it, and pay for convenience around it.

## Business Hypothesis

The product can be open source and still make money if the hosted version is useful, convenient, and transparent.

Possible model:

- Free and open source core.
- Bring your own keys.
- Hosted convenience for people who do not want to run infrastructure.
- Transparent usage-based billing.
- Possibly a very low monthly base price.
- No lock-in.

The value capture has to come from convenience, reliability, support, hosted infrastructure, team workflows, and distribution, not from trapping users.

## Immediate Risk

The main risk is not ideology.

The main risk is failing to ship.

The idea has been stable for months: user-owned agents, browser first, open source, personal intelligence, extensible software. The bottleneck is turning it into a working artifact and showing it to people.

## Today’s Goal

Launch something today.

Not the complete company. Not the perfect architecture. Not the final local-first system.

Launch a visible artifact that proves forward motion:

1. A public repo with the project direction.
2. A minimal extension shell.
3. A working `Cmd+K` command surface.
4. A separate development bridge page that reloads the extension from code changes.
5. One experimental model-backed action loop.
6. A short public post explaining the belief and asking people to try it.

## Validation Plan

The goal is to invalidate or validate quickly.

Talk to people today. Ping people who might care. Do not wait for the full product before asking whether the direction matters.

Questions to answer:

- Do people want a browser interface they can own and modify?
- Is open source a real buying reason or mainly an ideology?
- Does browser-first feel obviously useful?
- Will anyone install an early extension?
- Will anyone bring their own API key?
- Will anyone customize a website before signing in?
- Would anyone pay for hosted convenience without lock-in?

## People

This likely needs collaborators.

The ambition is large enough that working alone may keep it trapped in notes and prototypes. The next useful move is not abstract hiring. It is finding a few people who care about the same thing and want to build with urgency.

Message people directly. Post publicly. Make the artifact legible enough that serious people can react to it.

## One-Sentence Version

Agee is an open source, user-owned browser interface that lets people invoke agents through voice or command mode on any website, starting as a Chrome extension and growing into a personal layer they can modify, self-host, and extend.

## Next Actions

1. Create the extension scaffold.
2. Add the `Cmd+K` interface.
3. Add screenshot capture.
4. Add the dev bridge so code changes reload into the extension without touching normal browsing.
5. Add model call with bring-your-own-key settings.
6. Add one experimental page action, such as clicking or typing into a selected element.
7. Write the README around ownership, interface-first, browser-native, and open source.
8. Post publicly and ping specific people.
