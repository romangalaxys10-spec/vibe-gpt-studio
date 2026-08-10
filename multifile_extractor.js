// multifile_extractor.js — parse multi-file LLM output into a file tree.
//
// Transport format (what the orchestrator + workers emit):
//
//   ```<lang> path=<relative/path>
//   <file contents>
//   ```
//
// Example:
//   ```php path=app/Controllers/UserController.php
//   <?php ...
//   ```
//
// Also tolerates the path on the line AFTER the fence opening (some models do
// this), and bare fenced blocks with no path (assigned a fallback name).
//
// Output: { files: [{ path, content, language }], errors: [{ raw, reason }] }

import path from 'path';

// Security: keep all paths under the project root. Reject absolute paths,
// parent traversal (../), and hidden/dotfiles that would escape.
export function safeJoinPath(projectRoot, relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  // Check absolute BEFORE stripping leading slash — isAbsolute on the raw input.
  if (path.isAbsolute(relPath.trim())) return null;
  const clean = relPath.trim().replace(/^\.?\//, '');
  if (!clean) return null;
  if (clean.includes('..')) return null;
  // block suspicious hidden paths
  if (clean.startsWith('.') && !clean.startsWith('./')) {
    // allow .htaccess, .env.example, etc. but block .git/ traversal
    if (clean === '.git' || clean.startsWith('.git/')) return null;
  }
  const resolved = path.resolve(projectRoot, clean);
  const rootResolved = path.resolve(projectRoot);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

export function extractFiles(text) {
  const files = [];
  const errors = [];
  if (!text) return { files, errors };

  // Match fenced blocks: ```lang optional-attrs \n content \n```
  // The "path=" attribute can be on the opening line OR the next line.
  const fenceRegex = /```([a-zA-Z0-9_+-]*)[ \t]*([^\n]*)\n([\s\S]*?)```/g;
  let m;
  let blockIdx = 0;
  while ((m = fenceRegex.exec(text)) !== null) {
    const lang = m[1] || '';
    let attrs = m[2] || '';
    let content = m[3] || '';
    blockIdx++;

    // Try to extract path from attrs line
    let filePath = parsePathAttr(attrs);

    // If no path in attrs, check if the first line of content is "path=..."
    if (!filePath) {
      const firstLineMatch = content.match(/^[ \t]*path[ \t]*=[ \t]*([^\n\r]+)/i);
      if (firstLineMatch) {
        filePath = firstLineMatch[1].trim();
        content = content.slice(firstLineMatch[0].length).replace(/^\r?\n/, '');
      }
    }

    if (!filePath) {
      // No path found — record as error (don't silently drop)
      errors.push({
        blockIndex: blockIdx,
        reason: 'no path= attribute found',
        preview: content.slice(0, 80),
      });
      continue;
    }

    files.push({
      path: filePath,
      content: content.replace(/\s+$/, '') + '\n', // normalize trailing whitespace, ensure newline
      language: lang || guessLanguage(filePath),
    });
  }

  // Also catch any code that's NOT fenced but the whole response is one file
  // (single-file fallback: if no fences matched and text looks like code)
  if (files.length === 0 && errors.length === 0) {
    const stripped = text.trim();
    if (stripped.startsWith('<?php') || stripped.startsWith('<!DOCTYPE') ||
        stripped.startsWith('<html') || stripped.startsWith('#!')) {
      // No path — can't place it. Record as error with the raw content.
      errors.push({
        blockIndex: 0,
        reason: 'single unfenced code block, no path= to place it',
        preview: stripped.slice(0, 80),
      });
    }
  }

  return { files, errors };
}

function parsePathAttr(attrs) {
  if (!attrs) return null;
  // Match: path="some/path" OR path=some/path OR path=some/path.ext
  const quoted = attrs.match(/path\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1].trim();
  const unquoted = attrs.match(/path\s*=\s*(\S+)/i);
  if (unquoted) return unquoted[1].trim();
  return null;
}

function guessLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const map = {
    php: 'php', js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', py: 'python',
    rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp',
    cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
    json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', md: 'markdown',
    vue: 'vue', svelte: 'svelte', txt: 'text',
  };
  return map[ext] || ext || 'text';
}

// Build a tree representation from a flat file list, for UI display.
// Returns { name, path, type: 'dir'|'file', children? }
export function buildFileTree(files) {
  const root = { name: '', path: '', type: 'dir', children: [] };
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find(c => c.name === part);
      if (!child) {
        child = { name: part, path: childPath, type: isLeaf ? 'file' : 'dir', children: isLeaf ? undefined : [] };
        node.children.push(child);
      }
      if (!isLeaf) node = child;
    }
  }
  // sort: dirs first, then files, alphabetical
  const sortNode = (n) => {
    if (!n.children) return;
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}
