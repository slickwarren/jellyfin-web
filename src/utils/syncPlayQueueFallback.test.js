import { describe, expect, it } from 'vitest';

import { getQueueToAdopt } from './syncPlayQueueFallback';

const emptyNewPlaylist = { Reason: 'NewPlaylist', Playlist: [], PlayingItemIndex: -1, StartPositionTicks: 21652891050 };
const creatorOnly = { GroupId: 'g1', Participants: ['slickwarren'], State: 'Waiting' };
const local = { ids: ['ep3', 'ep4', 'ep5'], startIndex: 0, positionTicks: 21652891050.4 };

describe('getQueueToAdopt', () => {
    it('sends the local queue when a new group starts empty during playback', () => {
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: local })).toEqual({
            ids: ['ep3', 'ep4', 'ep5'],
            startIndex: 0,
            startPositionTicks: 21652891050
        });
    });

    it('keeps the position of the playing item within the queue', () => {
        const result = getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: { ...local, startIndex: 2 } });
        expect(result.startIndex).toBe(2);
    });

    it('starts from the first item when the local index is unknown or out of range', () => {
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: { ...local, startIndex: -1 } }).startIndex).toBe(0);
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: { ...local, startIndex: 7 } }).startIndex).toBe(0);
    });

    it('does nothing when the server already sent a playlist (fixed server)', () => {
        const withItems = { ...emptyNewPlaylist, Playlist: [{ ItemId: 'ep3', PlaylistItemId: 'p1' }], PlayingItemIndex: 0 };
        expect(getQueueToAdopt({ playQueueUpdate: withItems, groupInfo: creatorOnly, localPlayback: local })).toBeNull();
    });

    it('does nothing for queue changes other than a new playlist', () => {
        expect(getQueueToAdopt({ playQueueUpdate: { ...emptyNewPlaylist, Reason: 'RemoveItems' }, groupInfo: creatorOnly, localPlayback: local })).toBeNull();
    });

    it('does nothing when joining a group that already has other members', () => {
        const shared = { ...creatorOnly, Participants: ['slickwarren', 'guest'] };
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: shared, localPlayback: local })).toBeNull();
    });

    it('does nothing when nothing is playing locally (group created from the home screen)', () => {
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: null })).toBeNull();
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: { ids: [], startIndex: -1, positionTicks: 0 } })).toBeNull();
    });

    it('never sends a negative or fractional position', () => {
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: { ...local, positionTicks: -5 } }).startPositionTicks).toBe(0);
        expect(getQueueToAdopt({ playQueueUpdate: emptyNewPlaylist, groupInfo: creatorOnly, localPlayback: { ...local, positionTicks: undefined } }).startPositionTicks).toBe(0);
    });
});
