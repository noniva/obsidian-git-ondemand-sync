import { describe, it, expect } from 'vitest';
import { mergeThreeWayKeepBoth } from '../src/sync/merge';

describe('mergeThreeWayKeepBoth', () => {
  it('merges non-overlapping edits from remote and local cleanly', () => {
    const base = 'line 1\nline 2\nline 3\nline 4';
    const remote = 'line 1 (desktop)\nline 2\nline 3\nline 4';
    const local = 'line 1\nline 2\nline 3\nline 4 (mobile)';
    expect(mergeThreeWayKeepBoth(base, remote, local)).toBe(
      'line 1 (desktop)\nline 2\nline 3\nline 4 (mobile)',
    );
  });

  it('keeps both remote and local lines without markers on colliding edits', () => {
    const base = 'header\ntarget\nfooter';
    const remote = 'header\ndesktop edit\nfooter';
    const local = 'header\nmobile edit\nfooter';
    const merged = mergeThreeWayKeepBoth(base, remote, local);
    expect(merged).toBe('header\ndesktop edit\nmobile edit\nfooter');
    expect(merged).not.toContain('<<<<<<<');
  });

  it('deduplicates identical edits made on both sides', () => {
    const base = 'a\nb\nc';
    const remote = 'a\nshared\nc';
    const local = 'a\nshared\nc';
    expect(mergeThreeWayKeepBoth(base, remote, local)).toBe('a\nshared\nc');
  });

  it('keeps both sides when base is empty (both created same path)', () => {
    expect(mergeThreeWayKeepBoth('', 'from desktop', 'from mobile')).toBe(
      'from desktop\nfrom mobile',
    );
  });

  it('normalizes CRLF line endings without false collisions', () => {
    const base = 'one\r\ntwo\r\nthree';
    const remote = 'one (d)\r\ntwo\r\nthree';
    const local = 'one\ntwo\nthree (m)';
    expect(mergeThreeWayKeepBoth(base, remote, local)).toBe('one (d)\ntwo\nthree (m)');
  });
});
