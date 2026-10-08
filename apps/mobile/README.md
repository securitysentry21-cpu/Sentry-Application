# Guard app (Expo SDK 57)

The native app is for **guards only**. Supervisors and duty officers use the web dashboard (D-04).

- **Phase 0:** a skeleton that compiles, lints and bundles (`expo export`).
- **Phase 0B:** a separate, throwaway tracking spike runs on real phones.
- **Phases 2–4:** the real screens and tracking (ARCH §22).

## Rules

- **Native folders are generated.** `android/` and `ios/` come from Expo's Continuous Native Generation and are git-ignored. Configure native behaviour in `app.json` and config plugins, never by editing generated folders.
- **Development builds, not Expo Go.** Background location needs native configuration (ARCH §2, EXT-44).
- **SDK-compatible versions:** add Expo and React Native libraries with `npx expo install <package>`.
- **Docs:** check the versioned documentation for SDK 57 (<https://docs.expo.dev/versions/v57.0.0/>). Expo changes APIs between SDK releases.
- **New Architecture only** (Expo SDK 55+): every native module must support it.
- **Over-the-air updates** never change native permissions or tracking behaviour (ARCH §19.7).

## App identifiers are placeholders

`com.example.sentry.guard` in `app.json` is deliberately unpublishable: Google Play rejects `com.example`. The real identifiers derive from a domain the company owns, and they are **permanent once published** (`docs/OPEN_QUESTIONS.md`, Q-20).
