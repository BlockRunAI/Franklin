# Desktop release notes

`desktop-ci.yml` publishes the release body from `<version>.md` in this
directory, where `<version>` is the tag with the `desktop-v` prefix stripped —
so tag `desktop-v0.2.0-beta.2` reads `0.2.0-beta.2.md`.

Write the notes here in the same PR as the version bump. Two reasons:

- Re-running the release job reproduces the same body. The workflow used to
  carry a hardcoded blurb, so a re-run silently replaced notes written by hand
  on the release page.
- The filename carries the version, so notes cannot go stale against a newer
  tag. A tag with no matching file falls back to a generic blurb rather than
  publishing the previous release's notes.
