import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { getCollectionApi } from '@jellyfin/sdk/lib/utils/api/collection-api';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';

import { ServerConnections } from 'lib/jellyfin-apiclient';

const QUEUE_NAME = 'audiobook queue';

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
            searchTerm: QUEUE_NAME,
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

    const audiobook = audiobooks.Items?.find(a => sameName(a.Name, item.Name));
    const queue = collections.Items?.find(c => sameName(c.Name, QUEUE_NAME));
    if (!queue) return { available: false, audiobook };

    const { data: queued } = await library.getItems({ userId, parentId: queue.Id });
    return {
        available: true,
        queueId: queue.Id,
        status: queue.Overview,
        queued: !!queued.Items?.some(i => i.Id === item.Id),
        audiobook
    };
}

export async function queueAudiobook(item, queueId) {
    const { api } = context(item);
    await getCollectionApi(api).addToCollection({ collectionId: queueId, ids: [item.Id] });
}
