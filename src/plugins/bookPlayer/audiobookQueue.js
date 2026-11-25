import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { getCollectionApi } from '@jellyfin/sdk/lib/utils/api/collection-api';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';

import { ServerConnections } from 'lib/jellyfin-apiclient';

export const AudiobookQueue = {
    Overnight: 'overnight',
    HighQuality: 'highQuality'
};

const QUEUE_NAMES = {
    [AudiobookQueue.Overnight]: 'audiobook queue (overnight)',
    [AudiobookQueue.HighQuality]: 'audiobook queue (high quality)'
};
const SEARCH_TERM = 'audiobook queue';

const sameName = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

function context(item) {
    const api = ServerConnections.getApi(item.ServerId);
    const userId = ServerConnections.getApiClient(item.ServerId).getCurrentUserId();
    return { api, userId, library: getLibraryApi(api) };
}

export async function getAudiobookStatus(item) {
    const { userId, library } = context(item);
    const [{ data: collections }, { data: audiobooks }] = await Promise.all([
        library.getItems({
            userId,
            includeItemTypes: [BaseItemKind.BoxSet],
            recursive: true,
            searchTerm: SEARCH_TERM,
            fields: [ItemFields.Overview]
        }),
        library.getItems({
            userId,
            includeItemTypes: [BaseItemKind.AudioBook],
            recursive: true,
            searchTerm: item.Name,
            limit: 10
        })
    ]);

    const queues = {};
    for (const [kind, name] of Object.entries(QUEUE_NAMES)) {
        const queue = collections.Items?.find(c => sameName(c.Name, name));
        if (queue) queues[kind] = { id: queue.Id, status: queue.Overview };
    }

    const memberships = await Promise.all(Object.entries(queues).map(async ([kind, queue]) => {
        const { data } = await library.getItems({ userId, parentId: queue.id });
        return data.Items?.some(i => i.Id === item.Id) ? kind : null;
    }));

    return {
        queues,
        queuedIn: memberships.find(Boolean) ?? null,
        audiobook: audiobooks.Items?.find(a => sameName(a.Name, item.Name))
    };
}

export async function queueAudiobook(item, queueId) {
    const { api } = context(item);
    await getCollectionApi(api).addToCollection({ collectionId: queueId, ids: [item.Id] });
}
