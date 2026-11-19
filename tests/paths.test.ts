import { describe, it, expect } from 'vitest';
import {
  normalizeVaultPath,
  isImagePath,
  isTextSyncPath,
  isIgnoredPath,
  parseEmbedWidth,
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
    expect(isImagePath('attachments/camera.heic')).toBe(true);
    expect(isImagePath('attachments/camera.HEIF')).toBe(true);
    expect(isImagePath('docs/manual.pdf')).toBe(false);
    expect(isTextSyncPath('notes/daily.md', ['.md', '.canvas', '.txt'])).toBe(true);
    expect(isTextSyncPath('docs/manual.pdf', ['.md', '.canvas', '.txt'])).toBe(false);
  });

  it('ignores .git and all dot-folders except .obsidian when enabled', () => {
    expect(isIgnoredPath('.git/config', true)).toBe(true);
    expect(isIgnoredPath('.github/PULL_REQUEST_TEMPLATE.md', true)).toBe(true);
    expect(isIgnoredPath('.vscode/notes.md', false)).toBe(true);
    expect(isIgnoredPath('notes/.hidden/secret.md', true)).toBe(true);
    expect(isIgnoredPath('.obsidian/app.json', false)).toBe(true);
    expect(isIgnoredPath('.obsidian/app.json', true)).toBe(false);
    expect(isIgnoredPath('.obsidian/.git/config', true)).toBe(true);
    expect(isIgnoredPath('.custom-obsidian/app.json', true, '.custom-obsidian')).toBe(false);
    expect(isIgnoredPath('.obsidian/app.json', true, '.custom-obsidian')).toBe(true);
    expect(isIgnoredPath('notes/git-notes.md', false)).toBe(false);
  });

  it('parses wikilink sizing/aliases, multi-pipe sizing, percent-encoding, and ignores external URLs', () => {
    expect(parseImageEmbed('folder/img.png|300')).toEqual({ target: 'folder/img.png', alt: undefined, width: 300 });
    expect(parseImageEmbed('img.png|300x200')).toEqual({ target: 'img.png', alt: undefined, width: 300 });
    expect(parseImageEmbed('img.png|alt text')).toEqual({ target: 'img.png', alt: 'alt text', width: undefined });
    expect(parseImageEmbed('img.png|alt text|300')).toEqual({ target: 'img.png', alt: 'alt text', width: 300 });
    expect(parseImageEmbed('img.png|alt text|300x200')).toEqual({ target: 'img.png', alt: 'alt text', width: 300 });
    expect(parseEmbedWidth('alt text|420')).toBe(420);
    expect(parseImageEmbed('attachments/my%20photo.png')).toEqual({
      target: 'attachments/my photo.png',
      alt: undefined,
      width: undefined,
    });
    expect(parseImageEmbed('attachments/100%bad.png')).toEqual({
      target: 'attachments/100%bad.png',
      alt: undefined,
      width: undefined,
    });
    expect(parseImageEmbed('//example.com/a.png')).toBeNull();
    expect(parseImageEmbed('https://example.com/a.png')).toBeNull();
    expect(parseImageEmbed('http://example.com/a.png')).toBeNull();
    expect(parseImageEmbed('data:image/png;base64,AAA')).toBeNull();
    expect(parseImageEmbed('')).toBeNull();
  });

  it('resolves short, relative, and percent-encoded remote image paths', () => {
    const index = ['attachments/pic.png', 'attachments/my photo.png', 'sub/nested.jpg', 'notes/sub/local.webp'];
    expect(resolveRemoteImagePath('pic.png', 'notes', index)).toBe('attachments/pic.png');
    expect(resolveRemoteImagePath('attachments/my%20photo.png', 'notes', index)).toBe('attachments/my photo.png');
    expect(resolveRemoteImagePath('sub/nested.jpg', '', index)).toBe('sub/nested.jpg');
    expect(resolveRemoteImagePath('../local.webp', 'notes/sub/deep', index)).toBe('notes/sub/local.webp');
    expect(resolveRemoteImagePath('missing.png', '', index)).toBeNull();

    const encodedIndex = ['attachments/my%20literal.png'];
    const parsedLiteral = parseImageEmbed('attachments/my%2520literal.png');
    expect(parsedLiteral).toEqual({ target: 'attachments/my%20literal.png', alt: undefined, width: undefined });
    expect(resolveRemoteImagePath(parsedLiteral!.target, '', encodedIndex, { decodeTarget: false })).toBe('attachments/my%20literal.png');
  });

  it('computes deterministic sha256 hex', async () => {
    const hash = await sha256Hex('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
