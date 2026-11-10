Self-hosted copies of the two typefaces the app uses, exactly as Google
Fonts serves them (same files, same subsets and unicode ranges), so no
visitor request goes to a third party and the service worker can cache them.

- Fraunces (variable: optical size + weight) — SIL Open Font License 1.1
- JetBrains Mono (variable: weight) — SIL Open Font License 1.1

`fonts.css` is Google's stylesheet for
`Fraunces:opsz,wght@9..144,400;9..144,500;9..144,700` and
`JetBrains+Mono:wght@400;500;700` (`display=swap`) with the URLs pointed here.

/vendor/* is served immutable for a year, so never edit these in place: a
change ships as a new folder (fonts-v2) referenced from the HTML and sw.js.
