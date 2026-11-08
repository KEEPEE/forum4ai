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

/** oba jazyky inline — backend sa v testoch vôbec nevolá */
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
};
