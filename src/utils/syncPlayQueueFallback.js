/**
 * Workaround for a Jellyfin server regression (jellyfin/jellyfin a3b2b9c07f, May 2026; fix pending
 * in jellyfin/jellyfin#18198). Servers built from master since then no longer record a session's
 * play queue while it plays, only when playback stops. A SyncPlay group created during playback
 * is seeded from that queue, so it starts with an empty playlist (PlayingItemIndex -1) and every
 * client waits for content forever.
 *
 * When that happens, the client that created the group sends its own queue instead: the same
 * SetNewQueue request it sends when play is pressed inside a group. With a fixed server the group
 * never starts empty during playback, so this never triggers and can be removed.
 */

/**
 * Decides whether the local queue should be sent to a group that started with an empty queue.
 * @param {Object} args
 * @param {Object} args.playQueueUpdate - the PlayQueue update just received from the server
 * @param {Object} args.groupInfo - the joined group's info (GroupJoined data)
 * @param {Object|null} args.localPlayback - what the local player was playing: ids, startIndex, positionTicks
 * @returns {Object|null} options for Controller.play (ids, startIndex, startPositionTicks), or null
 */
export function getQueueToAdopt({ playQueueUpdate, groupInfo, localPlayback }) {
    if (playQueueUpdate?.Reason !== 'NewPlaylist' || playQueueUpdate.Playlist?.length) {
        return null;
    }

    // Only for the group's creator. With other members present, an empty queue is simply an idle
    // group, and joining one must not replace it with this client's playback.
    if ((groupInfo?.Participants?.length ?? 0) > 1) {
        return null;
    }

    if (!localPlayback?.ids?.length) {
        return null;
    }

    const startIndex = localPlayback.startIndex >= 0 && localPlayback.startIndex < localPlayback.ids.length ?
        localPlayback.startIndex :
        0;

    return {
        ids: localPlayback.ids.slice(0),
        startIndex,
        startPositionTicks: Math.max(0, Math.round(localPlayback.positionTicks || 0))
    };
}
