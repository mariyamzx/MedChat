// ── Minimal markdown renderer ────────────────────────────────────────────────
//
// The backend's `reply` field is markdown: **bold** runs, "- " bullet lines,
// and blank-line-separated blocks. Rendering it as plain text would show raw
// asterisks to the patient.
//
// This is deliberately not react-markdown. The backend emits exactly three
// constructs, all of them from its own code rather than from user input, so a
// ~50 line renderer covers it completely and adds no dependency to install.
// It also never uses dangerouslySetInnerHTML, so model output cannot inject
// markup.

import type { ReactNode } from 'react'

/** Splits a line into text and bold runs on ** delimiters. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)

  return parts.filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <span key={`${keyPrefix}-t${i}`}>{part}</span>
  })
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = (text || '').trim().split(/\n{2,}/)

  return (
    <div className={`space-y-2.5 ${className}`}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n').filter(l => l.trim())

        // A block can be a heading line followed by bullets, so headings and
        // list items are collected separately rather than assuming one shape.
        const leading: string[] = []
        const bullets: string[] = []

        for (const line of lines) {
          const trimmed = line.trim()
          if (/^[-*•]\s+/.test(trimmed)) {
            bullets.push(trimmed.replace(/^[-*•]\s+/, ''))
          } else if (bullets.length === 0) {
            leading.push(trimmed)
          } else {
            // Text after a list starts a new visual paragraph.
            bullets.push(trimmed)
          }
        }

        return (
          <div key={`blk-${bi}`} className="space-y-1.5">
            {leading.map((line, li) => (
              <p key={`blk-${bi}-l${li}`} className="leading-relaxed">
                {renderInline(line, `blk-${bi}-l${li}`)}
              </p>
            ))}

            {bullets.length > 0 && (
              <ul className="space-y-1 pl-0.5">
                {bullets.map((item, ii) => (
                  <li key={`blk-${bi}-i${ii}`} className="flex gap-2 leading-relaxed">
                    <span className="text-lav-400 flex-shrink-0 select-none">•</span>
                    <span>{renderInline(item, `blk-${bi}-i${ii}`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
