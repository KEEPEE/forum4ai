/**
 * Testovacie i18n (Phase 2a).
 *
 * Testy renderujú v SK — 363 existujúcich asertov počítajú so
 * slovenským textom. Preto setup inicializuje i18n SYNCHRONNE s
 * resources pre EN aj SK (rovnaké JSON súbory, importované priamo —
 * nie cez lazy backend) a s `lng: 'sk'`. Test na to, že APPKA defaultne
 * hovorí po anglicky, je samostatný (`test/i18n.test.ts`), lebo potrebuje
 * vlastnú i18next inštanciu s detectorom.
 */
import type { Resource } from 'i18next';

import { enResources } from '../src/i18n/resources.js';
import deAdmin from '../src/locales/de/admin.json';
import deAuth from '../src/locales/de/auth.json';
import deCommon from '../src/locales/de/common.json';
import deForum from '../src/locales/de/forum.json';
import dePaper from '../src/locales/de/paper.json';
import deRegister from '../src/locales/de/register.json';
import deSettings from '../src/locales/de/settings.json';
import deWrite from '../src/locales/de/write.json';
import skAdmin from '../src/locales/sk/admin.json';
import skAuth from '../src/locales/sk/auth.json';
import skCommon from '../src/locales/sk/common.json';
import skForum from '../src/locales/sk/forum.json';
import skPaper from '../src/locales/sk/paper.json';
import skRegister from '../src/locales/sk/register.json';
import skSettings from '../src/locales/sk/settings.json';
import skWrite from '../src/locales/sk/write.json';

/** jazyk, v ktorom testy renderujú (default existujúcich asertov) */
export const TEST_LANG = 'sk';

/**
 * All languages inline — the backend is never called in a test. F4AI-43 added
 * `de` here so the German plural forms and the language menu can be rendered
 * without a dynamic import.
 */
export const TEST_RESOURCES: Resource = {
  ...enResources,
  sk: {
    common: skCommon,
    forum: skForum,
    write: skWrite,
    auth: skAuth,
    admin: skAdmin,
    settings: skSettings,
    register: skRegister,
    paper: skPaper,
  },
  de: {
    common: deCommon,
    forum: deForum,
    write: deWrite,
    auth: deAuth,
    admin: deAdmin,
    settings: deSettings,
    register: deRegister,
    paper: dePaper,
  },
};
