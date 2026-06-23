import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow, ProjectVisibility } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    /**
     * Inserts (or reactivates an archived) project path. When `createdBy` is the
     * id of the authenticated creator it is recorded on first insert so the
     * private-project authorization layer (B-PRIV) can identify the owner.
     * Pre-existing/reactivated rows keep their original created_by — a path that
     * already exists is never re-attributed by this upsert.
     */
    createProjectPath(
        projectPath: string,
        customProjectName: string | null = null,
        createdBy: number | null = null,
    ): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const normalizedCreatedBy = Number.isInteger(createdBy) ? createdBy : null;
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, created_by)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName, normalizedCreatedBy) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    getProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     */
    getArchivedProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, visibility, created_by
            FROM projects
            WHERE isArchived = 1
        `).all() as ProjectRepositoryRow[];
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
    },

    /** Sets a project's visibility ('public' | 'private') by project id. */
    setProjectVisibility(projectId: string, visibility: ProjectVisibility): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET visibility = ?
            WHERE project_id = ?
        `).run(visibility, projectId);
    },

    /** Reads a project's visibility by id, or null when the project is unknown. */
    getProjectVisibility(projectId: string): ProjectVisibility | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT visibility
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as { visibility: ProjectVisibility } | undefined;

        return row?.visibility ?? null;
    },

    /** Sets a project's creator (created_by) by id. Used by orphan-recovery. */
    setProjectCreatedBy(projectId: string, userId: number | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET created_by = ?
            WHERE project_id = ?
        `).run(Number.isInteger(userId) ? userId : null, projectId);
    },

    /**
     * Project paths VISIBLE to the given user — the single source of truth for
     * the private-project privacy guarantee (B-PRIV). A path is visible when the
     * project is public, OR the user created it, OR the user is an explicit
     * project_members row, OR the user is derived from session participation.
     *
     * Privacy is ABSOLUTE: there is intentionally NO platform-owner bypass here.
     * The platform owner sees a private project only via one of the four
     * membership routes above — never by role. Returned as a de-duplicated set of
     * active (non-archived) project paths.
     */
    getVisibleProjectPaths(userId: number | null): string[] {
        const db = getConnection();

        // Unauthenticated / missing identity: only public projects are visible.
        if (!Number.isInteger(userId)) {
            const publicRows = db.prepare(`
                SELECT project_path
                FROM projects
                WHERE isArchived = 0 AND visibility = 'public'
            `).all() as Array<{ project_path: string }>;
            return publicRows.map((row) => row.project_path);
        }

        const rows = db.prepare(`
            SELECT DISTINCT p.project_path AS project_path
            FROM projects p
            WHERE p.isArchived = 0
              AND (
                p.visibility = 'public'
                OR p.created_by = ?
                OR EXISTS (
                    SELECT 1 FROM project_members pm
                    WHERE pm.project_id = p.project_id AND pm.user_id = ?
                )
                OR EXISTS (
                    SELECT 1
                    FROM session_participants sp
                    JOIN sessions s ON s.session_id = sp.session_id
                    WHERE sp.user_id = ?
                      AND s.project_path = p.project_path
                )
              )
        `).all(userId, userId, userId) as Array<{ project_path: string }>;

        return rows.map((row) => row.project_path);
    },

    /**
     * Whether a single project is visible to the user (B-PRIV guard primitive).
     * Mirrors getVisibleProjectPaths but resolves one project by id without
     * materializing the full visible set. Returns false for unknown projects so
     * callers can answer 404 (existence is not disclosed). Archived state does
     * NOT affect visibility here — archived private projects must stay protected
     * for management/restore paths that operate on archived rows by id.
     */
    isProjectVisibleToUser(projectId: string, userId: number | null): boolean {
        const db = getConnection();
        const row = db.prepare(`
            SELECT
                p.project_id AS project_id,
                p.visibility AS visibility,
                p.created_by AS created_by,
                EXISTS (
                    SELECT 1 FROM project_members pm
                    WHERE pm.project_id = p.project_id AND pm.user_id = ?
                ) AS isMember,
                EXISTS (
                    SELECT 1
                    FROM session_participants sp
                    JOIN sessions s ON s.session_id = sp.session_id
                    WHERE sp.user_id = ?
                      AND s.project_path = p.project_path
                ) AS isParticipant
            FROM projects p
            WHERE p.project_id = ?
        `).get(
            Number.isInteger(userId) ? userId : -1,
            Number.isInteger(userId) ? userId : -1,
            projectId,
        ) as
            | { visibility: ProjectVisibility; created_by: number | null; isMember: number; isParticipant: number }
            | undefined;

        if (!row) {
            return false;
        }
        if (row.visibility === 'public') {
            return true;
        }
        if (!Number.isInteger(userId)) {
            return false;
        }
        return row.created_by === userId || row.isMember === 1 || row.isParticipant === 1;
    },
};
