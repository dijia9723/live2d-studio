const htmlPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const htmlPrelude = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${htmlPolicy}"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>`
const pauseAnimations = '<style>*, *::before, *::after { animation-play-state: paused !important; }</style>'

export default function StageHTMLFrame({
  title,
  source,
  preview = false,
}: {
  title: string
  source: string
  preview?: boolean
}) {
  return (
    <iframe
      className="stage-html-frame"
      title={title}
      srcDoc={htmlPrelude + (preview ? pauseAnimations : '') + source}
      sandbox=""
      referrerPolicy="no-referrer"
      loading={preview ? 'lazy' : undefined}
      aria-hidden={preview || undefined}
      inert
      tabIndex={-1}
    />
  )
}
