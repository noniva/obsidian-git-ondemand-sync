import { describe, it, expect } from 'vitest';
import {
  normalizeVaultPath,
  isImagePath,
  isTextSyncPath,
  isIgnoredPath,
  parseImageEmbed,
  resolveRemoteImagePath,
  sha256Hex,
} from '../src/utils/paths';

describe('paths', () => {
  it('normalizes vault paths cleanly', () => {
    expect(normalizeVaultPath('\\\\notes\\\\sub//daily.md/')).toBe('notes/sub/daily.md');
    expect(normalizeVaultPath('./attachments/pic.png')).toBe('attachments/pic.png');
    expect(normalizeVaultPath('/root/./sub/../img.png')).toBe('root/img.png');
  });

  it('detects image and allowlisted text extensions', () => {
    expect(isImagePath('attachments/Photo.PNG')).toBe(true);
    expect(isImagePath('docs/manual.pdf')).toBe(false);
    expect(isTextSyncPath('notes/daily.md', ['.md', '.canvas', '.txt'])).toBe(true);
    expect(isTextSyncPath('docs/manual.pdf', ['.md', '.canvas', '.txt'])).toBe(false);
  });

  it('ignores .git always and .obsidian unless enabled', () => {
    expect(isIgnoredPath('.git/config', true)).toBe(true);
    expect(isIgnoredPath('.obsidian/app.json', false)).toBe(true);
    expect(isIgnoredPath('.obsidian/app.json', true)).toBe(false);
    expect(isIgnoredPath('notes/git-notes.md', false)).toBe(false);
  });

  it('parses wikilink sizing/aliases and ignores external URLs', () => {
    expect(parseImageEmbed('folder/img.png|300')).toEqual({ target: 'folder/img.png', width: 300 });
    expect(parseImageEmbed('img.png|300x200')).toEqual({ target: 'img.png', width: 300 });
    expect(parseImageEmbed('img.png|alt text')).toEqual({ target: 'img.png', width: undefined });
    expect(parseImageEmbed('https://example.com/a.png')).toBeNull();
    expect(parseImageEmbed('http://example.com/a.png')).toBeNull();
    expect(parseImageEmbed('data:image/png;base64,AAA')).toBeNull();
    expect(parseImageEmbed('')).toBeNull();
  });

  it('resolves short and relative remote image paths', () => {
    const index = ['attachments/pic.png', 'sub/nested.jpg', 'notes/sub/local.webp'];
    expect(resolveRemoteImagePath('pic.png', 'notes', index)).toBe('attachments/pic.png');
    expect(resolveRemoteImagePath('sub/nested.jpg', '', index)).toBe('sub/nested.jpg');
    expect(resolveRemoteImagePath('../local.webp', 'notes/sub/deep', index)).toBe('notes/sub/local.webp');
    expect(resolveRemoteImagePath('missing.png', '', index)).toBeNull();
  });

  it('computes deterministic sha256 hex', async () => {
    const hash = await sha256Hex('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
