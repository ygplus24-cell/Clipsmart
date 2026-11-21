/**
 * Payload-First Security TDD Spec for ClipGenius AI Firestore Rules.
 * Verifies that all 12 Dirty Dozen adversarial payloads violate the ruleset.
 *
 * Run against Firebase Rules Emulator when available:
 *   npx vitest run firestore.rules.test.ts
 */
import fs from 'fs';
import path from 'path';

export interface AdversarialTestCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: AdversarialTestCase[] = [
  {
    id: 1,
    name: 'Cross-user profile spoof on create',
    operation: 'create',
    path: '/users/userA',
    auth: { uid: 'userB', email_verified: true },
    payload: { ownerId: 'userA', displayName: 'Spoofed' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Owner hijack inside project payload',
    operation: 'create',
    path: '/users/userA/projects/proj_1',
    auth: { uid: 'userA', email_verified: true },
    payload: { ownerId: 'userB', id: 'proj_1', title: 'Hijack' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Shadow ghost field injection (isAdmin)',
    operation: 'create',
    path: '/users/userA',
    auth: { uid: 'userA', email_verified: true },
    payload: { ownerId: 'userA', displayName: 'Creator', isAdmin: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Unverified email user write attempt',
    operation: 'create',
    path: '/users/userA/preferences/studio',
    auth: { uid: 'userA', email_verified: false },
    payload: { ownerId: 'userA', geminiModel: 'gemini-4-hydrogen' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Cross-user PII private info read',
    operation: 'get',
    path: '/users/userA/private/info',
    auth: { uid: 'userB', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Cross-user project list scraping',
    operation: 'list',
    path: '/users/userA/projects',
    auth: { uid: 'userB', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Path ID poisoning with oversized or invalid ID',
    operation: 'create',
    path: `/users/userA/projects/${'a'.repeat(200)}`,
    auth: { uid: 'userA', email_verified: true },
    payload: { ownerId: 'userA', id: 'a'.repeat(200), title: 'Bad ID' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Denial-of-wallet oversized string and unbounded hashtags',
    operation: 'create',
    path: '/users/userA/projects/proj_1/clips/clip_1',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      ownerId: 'userA',
      projectId: 'proj_1',
      id: 'clip_1',
      title: 'x'.repeat(5000),
      hashtags: Array.from({ length: 100 }, (_, i) => `#tag${i}`),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Client-forged createdAt timestamp instead of request.time',
    operation: 'create',
    path: '/users/userA',
    auth: { uid: 'userA', email_verified: true },
    payload: {
      ownerId: 'userA',
      displayName: 'Creator',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Immutable ownerId mutation on clip update',
    operation: 'update',
    path: '/users/userA/projects/proj_1/clips/clip_1',
    auth: { uid: 'userA', email_verified: true },
    payload: { ownerId: 'userB' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Orphaned clip creation without existing parent project',
    operation: 'create',
    path: '/users/userA/projects/missing_proj/clips/clip_1',
    auth: { uid: 'userA', email_verified: true },
    payload: { ownerId: 'userA', projectId: 'missing_proj', id: 'clip_1' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Value-type poisoning on whitelisted project update',
    operation: 'update',
    path: '/users/userA/projects/proj_1',
    auth: { uid: 'userA', email_verified: true },
    payload: { title: 999999 },
    expected: 'PERMISSION_DENIED',
  },
];

export function verifyStaticRulesInvariants(rulesPath = 'firestore.rules'): void {
  const fullPath = path.resolve(process.cwd(), rulesPath);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const requiredAssertions = [
    "rules_version = '2';",
    'match /{document=**} {\n      allow read, write: if false;\n    }',
    'email_verified == true',
    'isValidId(',
    'request.time',
    'affectedKeys().hasOnly(',
  ];
  for (const snippet of requiredAssertions) {
    if (!content.includes(snippet)) {
      throw new Error(`Missing required security invariant in ${rulesPath}: ${snippet}`);
    }
  }
}
