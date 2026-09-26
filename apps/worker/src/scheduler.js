// Use a direct PostgreSQL connection (not a transaction-mode pooler) so the
// session advisory lock remains attached to this connection across queries.
export function createDueSearchRunner({ db, listDueSearchGroups, listSearchGroups, getProfile, advanceSearchGroup, runProfile }) {
  return async function runDueSearches() {
    const client = await db.pool.connect();
    let locked = false;
    const result = { skipped: false, groupsCompleted: 0, profilesCompleted: 0, errors: [] };
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(72819462) AS locked');
      locked = lock.rows[0].locked;
      if (!locked) return { ...result, skipped: true };
      for (const group of await listDueSearchGroups(db)) {
        try {
          const current = (await listSearchGroups(db)).find((entry) => entry.id === group.id);
          if (!current || current.intervalMinutes <= 0) continue;
          for (const entry of current.profiles.filter((profile) => profile.enabled)) {
            const profile = await getProfile(db, entry.id);
            if (!profile?.enabled) continue;
            await runProfile(profile);
            result.profilesCompleted += 1;
          }
          // Failed groups stay due for the next call; completed groups aren't repeated.
          await advanceSearchGroup(db, group.id, current.intervalMinutes);
          result.groupsCompleted += 1;
        } catch (error) {
          console.error(`Scheduled group ${group.id} failed:`, error);
          result.errors.push({ groupId: group.id, error: 'Search failed; see run history and server logs' });
        }
      }
      return result;
    } finally {
      // Destroy the dedicated connection, releasing its lock even after errors.
      client.release(true);
    }
  };
}
