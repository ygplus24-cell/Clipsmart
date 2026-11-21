# ClipGenius AI — Firestore Security Specification

## 1. Data Invariants
1. **Default-Deny Baseline:** Every collection or path not explicitly matched is denied via `match /{document=**} { allow read, write: if false; }`.
2. **Verified Identity Ownership:** All user data lives under `/users/{userId}`. Reads and writes require `request.auth != null`, `request.auth.token.email_verified == true`, and `request.auth.uid == userId`, with `ownerId == request.auth.uid` immutable across updates.
3. **PII Isolation:** Creator email (`email`, `emailVerified`) is isolated inside `/users/{userId}/private/info` and strictly readable/writable only by the owner (`userId == request.auth.uid`).
4. **Master Gate Relational Integrity:** Every clip under `/users/{userId}/projects/{projectId}/clips/{clipId}` verifies that its parent `/users/{userId}/projects/{projectId}` exists and has `ownerId == request.auth.uid` on create/update/delete. Every publish job under `/users/{userId}/publishJobs/{jobId}` verifies its referenced project exists and is owned by `request.auth.uid` on create.
5. **Path ID & Payload Boundary Enforcement:** Document IDs (`userId`, `projectId`, `clipId`, `jobId`, `docId`) must match `^[a-zA-Z0-9_-]+$` and `size() <= 128`. Every string field has an explicit `.size()` ceiling, every array has a `.size()` ceiling, and `createdAt` / `updatedAt` must equal `request.time`.
6. **Zero Shadow Fields & Explicit Action Keys:** All `create` operations require `keys().hasAll(...) && keys().hasOnly(...)`. All `update` operations call `isValid[Entity](incoming())` first and restrict mutable keys via `incoming().diff(existing()).affectedKeys().hasOnly(...)`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Cross-User Profile Spoof (Create):** User B (`uid: "userB"`) attempts to create `/users/userA` with `ownerId: "userA"`.
2. **Owner Hijack in Payload (Create):** User A (`uid: "userA"`) attempts to create `/users/userA/projects/proj_1` with `ownerId: "userB"`.
3. **Ghost / Shadow Field Injection (Create):** User A attempts to create `/users/userA` including an undeclared field `isAdmin: true` or `role: "superuser"`.
4. **Unverified Email Bypass (Create):** Authenticated user with `email_verified: false` attempts to write `/users/userA/preferences/studio`.
5. **PII Leakage / Cross-User Read (Get):** User B attempts to read `/users/userA/private/info`.
6. **Blanket List Query Scraping (List):** User B attempts to list `/users/userA/projects` or query projects where `ownerId != request.auth.uid`.
7. **ID Poisoning Attack (Create):** User A attempts to create `/users/userA/projects/../../../etc/passwd` or a 500-character document ID.
8. **Denial-of-Wallet Resource Exhaustion (Create/Update):** User A attempts to write a 10,000-character `title` or an array of 500 `hashtags` on a clip.
9. **Immutable Timestamp Forgery (Create/Update):** User A sends a client-forged `createdAt` timestamp instead of `serverTimestamp()` (`request.time`), or modifies `createdAt` during an update.
10. **Immutable Ownership Mutation (Update):** User A attempts to change `ownerId` or `projectId` on an existing `StudioClip` via `update`.
11. **Orphaned Subcollection Write (Create):** User A attempts to create `/users/userA/projects/nonexistent_proj/clips/clip_1` when parent project `nonexistent_proj` does not exist.
12. **Value-Type Poisoning on Whitelisted Update (Update):** User A updates `title` on an existing project with a boolean `true` or number `12345` instead of a bounded string.
