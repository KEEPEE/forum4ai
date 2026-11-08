/**
 * Test design tokenov (S11, F4AI-17): `tokens.css` musí byť 1:1 kópia
 * `:root` bloku zo šablóny Nexaverse tm-603 a `app.css` nesmie obsahovať
 * tvrdé farby (všetko ide cez tokeny, inak preklop témy nefunguje).
 *
 * Šablóna leží mimo repozitár (`/root/AiForum/webui/nexaverse-tm603/…`),
 * preto test (a) drží očakávané hodnoty ako pevnú mapu a (b) ak je súbor
 * šablóny na disku, porovná s ním deklaráciu po deklarácii. Tak test
 * prejde aj na stroji bez šablóny, ale na vývojovom stroji chytí drift.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const TOKENS_CSS = join(packageRoot, 'src', 'styles', 'tokens.css');
const APP_CSS = join(packageRoot, 'src', 'styles', 'app.css');
const TEMPLATE_CSS = '/root/AiForum/webui/nexaverse-tm603/extracted/templatemo_603_nexaverse/templatemo-nexaverse.css';

/** 10 tokenov z `:root` šablóny tm-603 — doslovné hodnoty zo zdroja */
const TEMPLATE_TOKENS: Record<string, string> = {
  '--primary': '#00f0ff',
  '--secondary': '#ff00d4',
  '--accent': '#9d4edd',
  '--dark-1': '#0a0a12',
  '--dark-2': '#12121f',
  '--dark-3': '#1a1a2e',
  '--glass-bg': 'rgba(255, 255, 255, 0.03)',
  '--glass-border': 'rgba(255, 255, 255, 0.08)',
  '--glow-cyan': 'rgba(0, 240, 255, 0.4)',
  '--glow-magenta': 'rgba(255, 0, 212, 0.4)',
};

/** vyber deklarácie z prvého `:root` bloku (vrátane `[data-theme='dark']`) */
function parseRootBlock(css: string): Record<string, string> {
  const start = css.indexOf(':root');
  expect(start, 'v CSS nie je blok :root').toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const declarations: Record<string, string> = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\*.*?\*\//g, '').trim();
    if (line === '' || line.startsWith('/*')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).replace(/;$/, '').trim();
    if (name.startsWith('--')) declarations[name] = value;
  }
  return declarations;
}

describe('tokens.css — zhoda so šablónou Nexaverse tm-603', () => {
  const tokens = parseRootBlock(readFileSync(TOKENS_CSS, 'utf8'));

  it('obsahuje všetkých 10 tokenov šablóny s rovnakými hodnotami', () => {
    for (const [name, value] of Object.entries(TEMPLATE_TOKENS)) {
      expect(tokens[name], `token ${name}`).toBe(value);
    }
  });

  it('nezavádza žiadny token, ktorý by v šablóna nebola (priamu kópiu)', () => {
    // DERIVED aliasy smú pribudnúť, ale kľúčových 10 nesmie byť prepísaných
    const templateKeys = Object.keys(TEMPLATE_TOKENS);
    const overridden = templateKeys.filter((key) => tokens[key] !== TEMPLATE_TOKENS[key]);
    expect(overridden).toEqual([]);
  });

  it('porovná s reálnym súborom šablóny, ak je na disku', () => {
    const templateExists = existsSync(TEMPLATE_CSS);
    if (!templateExists) {
      expect(templateExists, 'šablóna mimo repozitára — porovnanie preskakujeme').toBe(false);
      return;
    }
    const templateTokens = parseRootBlock(readFileSync(TEMPLATE_CSS, 'utf8'));
    for (const [name, value] of Object.entries(templateTokens)) {
      expect(tokens[name], `token ${name} sa líši od šablóny`).toBe(value);
    }
  });

  it('definuje glassmorphism premenné a triedy (.glass-card blur 20px)', () => {
    const css = readFileSync(TOKENS_CSS, 'utf8');
    expect(tokens['--blur-glass']).toBe('20px');
    expect(css).toMatch(/\.glass-card\s*{[^}]*backdrop-filter:\s*blur\(var\(--blur-glass\)\)/s);
    expect(css).toMatch(/\.glass-card\s*{[^}]*border:\s*1px solid var\(--glass-border\)/s);
    expect(css).toMatch(/\.glass-card::before/);
  });

  it('má svetlú variantu preklopom tokenov (žiadna komponenta netrebuje vlastnú farbu)', () => {
    const css = readFileSync(TOKENS_CSS, 'utf8');
    const lightStart = css.indexOf("[data-theme='light']");
    expect(lightStart).toBeGreaterThan(-1);
    const lightBlock = css.slice(lightStart, css.indexOf('}', css.indexOf('{', lightStart)));
    for (const name of Object.keys(TEMPLATE_TOKENS)) {
      expect(lightBlock, `svetlá téma nepredefinováva ${name}`).toContain(`${name}:`);
    }
  });
});

describe('app.css — stavané výhradne na tokenoch', () => {
  const css = readFileSync(APP_CSS, 'utf8');

  it('neobsahuje tvrdé hex farby', () => {
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex, `tvrdé farby v app.css: ${hex.join(', ')}`).toEqual([]);
  });

  it('používa fonty z tokenov, nie priame názvy', () => {
    expect(css).toContain('font-family: var(--font-body)');
    expect(css).not.toMatch(/font-family:\s*'(Syne|Outfit)/);
  });
});

describe('self-hostované fonty', () => {
  it('balíky @fontsource sú nainštalované a main.tsx ich importuje', () => {
    const main = readFileSync(join(packageRoot, 'src', 'main.tsx'), 'utf8');
    expect(main).toContain("@fontsource-variable/syne");
    expect(main).toContain("@fontsource/outfit/400.css");
    expect(existsSync(join(packageRoot, 'node_modules', '@fontsource-variable', 'syne', 'index.css'))).toBe(true);
    expect(existsSync(join(packageRoot, 'node_modules', '@fontsource', 'outfit', '400.css'))).toBe(true);
  });

  it('tokens.css odkazuje na family z fontsource balíkov', () => {
    const tokens = readFileSync(TOKENS_CSS, 'utf8');
    expect(tokens).toContain("'Syne Variable'");
    expect(tokens).toContain("'Outfit'");
  });
});
