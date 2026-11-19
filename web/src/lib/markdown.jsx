/**
 * A deliberately small markdown renderer.
 *
 * Answers can quote the student's own uploaded files, so every string here is
 * turned into React elements and never into raw HTML: there is no
 * `dangerouslySetInnerHTML` anywhere in this app, which means a PDF full of
 * `<script>` or an injected `[click](javascript:...)` cannot execute.
 *
 * Supported: headings, paragraphs, bold, italic, inline code, fenced code,
 * bullet and numbered lists, blockquotes, horizontal rules, http(s) links and
 * [S1] citation chips.
 */
import { useMemo } from 'react';

const INLINE_PATTERN =
  '(\\*\\*[^*]+\\*\\*|`[^`]+`|\\*[^*\\n]+\\*|_[^_\\n]+_|\\[[^\\]]+\\]\\([^)\\s]+\\)|\\[S\\d+\\])';

function InlineText({ text, citations, onCitation, idPrefix }) {
  const nodes = useMemo(() => {
    const pattern = new RegExp(INLINE_PATTERN, 'g');
    const out = [];
    let cursor = 0;
    let match;
    let index = 0;

    const push = (node) => out.push(node);

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor) push(text.slice(cursor, match.index));
      const token = match[0];
      const key = `${idPrefix}-${index}`;
      index += 1;

      if (token.startsWith('**')) {
        push(
          <strong key={key} className="md-strong">
            {token.slice(2, -2)}
          </strong>,
        );
      } else if (token.startsWith('`')) {
        push(
          <code key={key} className="md-code">
            {token.slice(1, -1)}
          </code>,
        );
      } else if (token[0] === '*' || token[0] === '_') {
        push(<em key={key}>{token.slice(1, -1)}</em>);
      } else if (/^\[S\d+\]$/.test(token)) {
        const citationId = token.slice(1, -1);
        const citation = citations.find((c) => c.id === citationId);
        if (citation) {
          push(
            <button
              key={key}
              type="button"
              className="cite-chip"
              onClick={() => onCitation?.(citation)}
              title={`${citation.documentName} — page ${citation.pageNumber}`}
              aria-label={`Source ${citationId}: ${citation.documentName} page ${citation.pageNumber}`}
            >
              {citationId}
            </button>,
          );
        } else {
          push(token);
        }
      } else {
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
        if (link && /^https?:\/\//i.test(link[2])) {
          push(
            <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
              {link[1]}
            </a>,
          );
        } else {
          push(token);
        }
      }
      cursor = match.index + token.length;
    }
    if (cursor < text.length) out.push(text.slice(cursor));
    return out;
  }, [text, citations, onCitation, idPrefix]);

  return <>{nodes}</>;
}

function parseBlocks(text, citations, onCitation) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let index = 0;
  let blockKey = 0;

  const nextKey = () => `b${blockKey++}`;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // fenced code
    if (/^\s*```/.test(line)) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={nextKey()} className="md-pre">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} className="md-hr" />);
      index += 1;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 1); // page owns h1
      const Tag = `h${level}`;
      blocks.push(
        <Tag key={nextKey()} className={`md-h md-h${level}`}>
          <InlineText
            text={heading[2]}
            citations={citations}
            onCitation={onCitation}
            idPrefix={nextKey()}
          />
        </Tag>,
      );
      index += 1;
      continue;
    }

    // bullet list
    if (/^\s*[-*•+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*•+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*•+]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={nextKey()} className="md-ul">
          {items.map((item, i) => (
            <li key={`${blockKey}-li${i}`}>
              <InlineText
                text={item}
                citations={citations}
                onCitation={onCitation}
                idPrefix={`${blockKey}-li${i}`}
              />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // numbered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={nextKey()} className="md-ol">
          {items.map((item, i) => (
            <li key={`${blockKey}-li${i}`}>
              <InlineText
                text={item}
                citations={citations}
                onCitation={onCitation}
                idPrefix={`${blockKey}-li${i}`}
              />
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={nextKey()} className="md-quote">
          <InlineText
            text={body.join(' ')}
            citations={citations}
            onCitation={onCitation}
            idPrefix={nextKey()}
          />
        </blockquote>,
      );
      continue;
    }

    // paragraph: consume until a blank line or the start of another block
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(#{1,6}\s|[-*•+]\s|\d+[.)]\s|>\s?|```)/.test(lines[index]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={nextKey()} className="md-p">
        <InlineText
          text={paragraph.join(' ')}
          citations={citations}
          onCitation={onCitation}
          idPrefix={nextKey()}
        />
      </p>,
    );
  }

  return blocks;
}

export function RichText({ text, citations = [], onCitation, className = '' }) {
  const blocks = useMemo(() => parseBlocks(text, citations, onCitation), [text, citations, onCitation]);
  if (!text) return null;
  return <div className={`rich-text ${className}`.trim()}>{blocks}</div>;
}

/** Single-line variant for titles and list rows. */
export function Inline({ text, citations = [], onCitation }) {
  return <InlineText text={String(text ?? '')} citations={citations} onCitation={onCitation} idPrefix="inline" />;
}

export default RichText;
