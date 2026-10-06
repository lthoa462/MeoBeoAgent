'use client'

/**
 * Safe GFM renderer for the coordinator's answer (adapted from the edge
 * sample's mdast pipeline).
 *
 * Answers are built from chat messages, which are untrusted input, so:
 * raw HTML is kept as text, link destinations are protocol-checked and open
 * with no referrer, and images are never loaded — an image URL is the classic
 * way a prompt-injected answer would leak chat content to a third party.
 */

import { Fragment, createElement } from 'react'
import type { Key, ReactNode } from 'react'
import type * as Md from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { normalizeUri } from 'micromark-util-sanitize-uri'
import clsx from 'clsx'
import css from './Markdown.module.css'

interface RenderContext {
  readonly definitions: ReadonlyMap<string, Md.Definition>
}

/** Render Markdown/GFM as React elements without injecting model-authored HTML. */
export function Markdown({ text }: { text: string }) {
  const root = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  const definitions = new Map<string, Md.Definition>()
  for (const node of root.children) {
    if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) {
      definitions.set(node.identifier.toUpperCase(), node)
    }
  }
  const context: RenderContext = { definitions }
  const children = root.children
    .map((node, index) => renderBlock(node, index, context))
    .filter((node): node is ReactNode => node !== null)
  return <div className={css.root}>{children}</div>
}

function renderBlock(node: Md.RootContent, key: Key, context: RenderContext): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key} className={css.paragraph}>{renderPhrasing(node.children, context)}</p>
    case 'heading':
      return createElement(
        `h${String(Math.min(node.depth + 1, 6))}`,
        { key, className: css.heading, 'data-level': node.depth },
        renderPhrasing(node.children, context),
      )
    case 'blockquote':
      return (
        <blockquote key={key} className={css.quote}>
          {node.children.map((child, index) => renderBlock(child, `${String(key)}-${String(index)}`, context))}
        </blockquote>
      )
    case 'thematicBreak':
      return <hr key={key} className={css.rule} />
    case 'break':
      return <Fragment key={key}><br />{'\n'}</Fragment>
    case 'code':
      return renderCode(node, key)
    case 'list':
      return renderList(node, key, context)
    case 'table':
      return renderTable(node, key, context)
    case 'html':
      return <p key={key} className={css.paragraph}>{node.value}</p>
    default:
      return null
  }
}

function renderPhrasing(nodes: readonly Md.PhrasingContent[], context: RenderContext): ReactNode[] {
  return nodes.map((node, index) => renderInline(node, index, context))
}

function renderInline(node: Md.PhrasingContent, key: Key, context: RenderContext): ReactNode {
  switch (node.type) {
    case 'text':
      return <Fragment key={key}>{renderText(node.value)}</Fragment>
    case 'emphasis':
      return <em key={key}>{renderPhrasing(node.children, context)}</em>
    case 'strong':
      return <strong key={key}>{renderPhrasing(node.children, context)}</strong>
    case 'delete':
      return <del key={key}>{renderPhrasing(node.children, context)}</del>
    case 'inlineCode':
      return <code key={key} className={css.inlineCode}>{node.value.replace(/\r?\n|\r/gu, ' ')}</code>
    case 'break':
      return <Fragment key={key}><br />{'\n'}</Fragment>
    case 'link':
      return renderLink(node.url, renderPhrasing(node.children, context), key)
    case 'linkReference': {
      const definition = context.definitions.get(node.identifier.toUpperCase())
      const children = renderPhrasing(node.children, context)
      return definition === undefined
        ? <Fragment key={key}>[{children}]</Fragment>
        : renderLink(definition.url, children, key)
    }
    case 'image':
    case 'imageReference':
      return <Fragment key={key}>{`[ảnh${node.alt === null || node.alt === undefined || node.alt === '' ? '' : `: ${node.alt}`}]`}</Fragment>
    case 'html':
      return <Fragment key={key}>{node.value}</Fragment>
    case 'footnoteReference':
      return <Fragment key={key}>{`[${node.label ?? node.identifier}]`}</Fragment>
    default:
      return null
  }
}

/** Models cite messages as `#n`; draw those as small chips so they read as references. */
function renderText(value: string): ReactNode {
  const parts = value.split(/((?<![\w#&])#\d{1,5}\b)/u)
  if (parts.length === 1) return value
  return parts.map((part, index) => (
    index % 2 === 1 ? <span key={index} className={css.cite}>{part}</span> : part
  ))
}

function renderLink(url: string, children: ReactNode[], key: Key): ReactNode {
  const safe = sanitizeUrl(url)
  if (safe === '') return <Fragment key={key}>{children}</Fragment>
  return (
    <a
      key={key}
      href={safe}
      title={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className={css.link}
    >
      {children}
    </a>
  )
}

function sanitizeUrl(value: string): string {
  const url = normalizeUri(value)
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? url : ''
  } catch {
    return ''
  }
}

function renderCode(node: Md.Code, key: Key): ReactNode {
  const language = node.lang ?? undefined
  return (
    <pre key={key} className={css.code}>
      {language !== undefined && language !== '' && <span className={css.codeLang}>{language}</span>}
      <code>{node.value}</code>
    </pre>
  )
}

function renderList(node: Md.List, key: Key, context: RenderContext): ReactNode {
  const tasks = node.children.some(item => typeof item.checked === 'boolean')
  return createElement(
    node.ordered === true ? 'ol' : 'ul',
    {
      key,
      className: clsx(css.list, tasks && css.taskList),
      ...(node.start !== null && node.start !== undefined && node.start !== 1 ? { start: node.start } : {}),
    },
    node.children.map((item, index) => renderListItem(item, index, context)),
  )
}

function renderListItem(item: Md.ListItem, key: Key, context: RenderContext): ReactNode {
  const children: ReactNode[] = []
  const checkbox = typeof item.checked === 'boolean'
    ? <input key="check" type="checkbox" checked={item.checked} disabled readOnly />
    : null
  for (const [index, child] of item.children.entries()) {
    // Tight list items hold their text in a paragraph; unwrap it so bullets
    // do not gain paragraph margins.
    const rendered = child.type === 'paragraph' && item.spread !== true
      ? <Fragment key={index}>{renderPhrasing(child.children, context)}</Fragment>
      : renderBlock(child, index, context)
    if (rendered === null) continue
    if (index === 0 && checkbox !== null) children.push(checkbox)
    children.push(rendered)
  }
  return <li key={key} className={checkbox === null ? undefined : css.task}>{children}</li>
}

function renderTable(node: Md.Table, key: Key, context: RenderContext): ReactNode {
  const [head, ...body] = node.children
  return (
    <div key={key} className={css.tableScroll} tabIndex={0}>
      <table className={css.table}>
        {head !== undefined && <thead>{renderTableRow(head, 'th', node.align, context)}</thead>}
        {body.length > 0 && <tbody>{body.map((row, index) => renderTableRow(row, 'td', node.align, context, index))}</tbody>}
      </table>
    </div>
  )
}

function renderTableRow(
  row: Md.TableRow,
  cellTag: 'th' | 'td',
  align: readonly Md.AlignType[] | null | undefined,
  context: RenderContext,
  key: Key = 0,
): ReactNode {
  const length = align === null || align === undefined ? row.children.length : Math.max(align.length, row.children.length)
  const cells: ReactNode[] = []
  for (let index = 0; index < length; index++) {
    const cell = row.children[index]
    const alignment = align?.[index]
    cells.push(createElement(
      cellTag,
      { key: index, style: alignment === null || alignment === undefined ? undefined : { textAlign: alignment } },
      ...(cell === undefined ? [] : renderPhrasing(cell.children, context)),
    ))
  }
  return <tr key={key}>{cells}</tr>
}
