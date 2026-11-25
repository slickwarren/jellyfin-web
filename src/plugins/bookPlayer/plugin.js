import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';

import { getImageUrl } from 'apps/legacy/features/playback/utils/image';
import { PluginType } from 'constants/pluginType';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import screenSaverManager from 'scripts/screensavermanager';

import actionsheet from '../../components/actionSheet/actionSheet';
import loading from '../../components/loading/loading';
import keyboardnavigation from '../../scripts/keyboardNavigation';
import dialogHelper from '../../components/dialogHelper/dialogHelper';
import { SUPPORTED_PLAYBACK_RATES } from '../../components/playback/playbackRateMenu';
import toast from '../../components/toast/toast';
import BookToc from './BookToc/BookToc';
import BookOsd from './BookOsd/BookOsd';
import { ReadAloud, ReadAloudMode, ReadAloudState } from './readAloud';
import globalize, { translateHtml } from '../../lib/globalize';
import * as userSettings from '../../scripts/settings/userSettings';
import Events from '../../utils/events.ts';
import { renderComponent } from '../../utils/reactUtils';

import 'material-design-icons-iconfont';
import '../../elements/emby-button/paper-icon-button-light';

import html from './template.html';
import './style.scss';

const THEMES = {
    'dark': { 'body': { 'color': '#d8dadc', 'background': '#000' }, 'link': '#8ab4f8', 'highlight': '#00a4dc' },
    'sepia': { 'body': { 'color': '#d8a262', 'background': '#000' }, 'link': '#e8bf8a', 'highlight': '#d8a262' },
    'light': { 'body': { 'color': '#000', 'background': '#fff' }, 'link': '#0b57d0', 'highlight': '#ffcc00' }
};
const THEME_ORDER = ['dark', 'sepia', 'light'];
const FONT_SIZES = ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large'];
const SUPPORTED_EXTENSIONS = ['.epub', '.mobi', '.azw', '.azw3', '.fb2', '.fbz', '.fb2.zip'];
const SETTINGS_KEY = 'bookplayer-settings';
const LOCATION_KEY_PREFIX = 'bookplayer-location-';
const RESUME_TOLERANCE = 0.02;
const TAP_ZONE = 0.25;
const HTML_TYPES = ['application/xhtml+xml', 'text/html'];
const CSP_META = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'"/>';

function readStorage(key) {
    try {
        return JSON.parse(localStorage.getItem(key)) || null;
    } catch {
        return null;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
        console.warn('[BookPlayer] failed to save', key, err);
    }
}

function getResumeLocation(itemId, fraction) {
    const saved = readStorage(LOCATION_KEY_PREFIX + itemId);
    if (saved?.cfi && typeof saved.fraction === 'number' && Math.abs(saved.fraction - fraction) <= RESUME_TOLERANCE) {
        return saved.cfi;
    }
    return fraction > 0 ? { fraction } : null;
}

function getStyles(theme, fontSize) {
    const { body, link } = THEMES[theme];
    return `
        html { color-scheme: ${theme === 'light' ? 'light' : 'dark'}; }
        html, body { color: ${body.color} !important; background: ${body.background} !important; }
        a:link, a:visited { color: ${link}; }
        pre { white-space: pre-wrap !important; }
        ${fontSize ? `a, p, div, li, span { font-size: ${fontSize} !important; }` : ''}
    `;
}

function injectCsp(markup) {
    const head = /<head\b[^>]*>/i.exec(markup);
    if (head) {
        const end = head.index + head[0].length;
        return markup.slice(0, end) + CSP_META + markup.slice(end);
    }
    const root = /<html\b[^>]*>/i.exec(markup);
    if (root) {
        const end = root.index + root[0].length;
        return markup.slice(0, end) + `<head>${CSP_META}</head>` + markup.slice(end);
    }
    return markup;
}

function blockScripts(book) {
    const target = book.transformTarget;
    if (!target) return;
    target.addEventListener('load', ({ detail }) => {
        if (detail.isScript) detail.allow = false;
    });
    target.addEventListener('data', ({ detail }) => {
        if (!HTML_TYPES.includes(detail.type)) return;
        detail.data = Promise.resolve(detail.data)
            .then(data => (typeof data === 'string' ? injectCsp(data) : data));
    });
}

async function fetchBook(url, item) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const name = item.Path?.split(/[\\/]/).pop() || `${item.Id}.epub`;
    return new File([await response.blob()], name);
}

export class BookPlayer {
    constructor() {
        this.name = 'Book Player';
        this.type = PluginType.MediaPlayer;
        this.id = 'bookplayer';
        this.priority = 1;
        this.THEMES = THEMES;
        this.readAloudEvents = new EventTarget();
        this.readAloudRate = 1;
        this.onDialogClosed = this.onDialogClosed.bind(this);
        this.openTableOfContents = this.openTableOfContents.bind(this);
        this.rotateTheme = this.rotateTheme.bind(this);
        this.setTheme = this.setTheme.bind(this);
        this.increaseFontSize = this.increaseFontSize.bind(this);
        this.decreaseFontSize = this.decreaseFontSize.bind(this);
        this.previous = this.previous.bind(this);
        this.next = this.next.bind(this);
        this.onWindowKeyDown = this.onWindowKeyDown.bind(this);
        this.onSectionLoad = this.onSectionLoad.bind(this);
        this.onRelocate = this.onRelocate.bind(this);
        this.onDocumentClick = this.onDocumentClick.bind(this);
        this.onReadAloudStateChange = this.onReadAloudStateChange.bind(this);
        this.onReadAloudError = this.onReadAloudError.bind(this);
        this.openReadAloudMenu = this.openReadAloudMenu.bind(this);
        this.openReadAloudRateMenu = this.openReadAloudRateMenu.bind(this);
        this.toggleReadAloud = this.toggleReadAloud.bind(this);
        this.stopReadAloud = this.stopReadAloud.bind(this);
        this.rewind = this.rewind.bind(this);
        this.fastForward = this.fastForward.bind(this);
    }

    play(options) {
        this.progress = 0;
        this.lastReportedProgress = null;
        this.cancellationToken = false;
        this.loaded = false;

        const settings = readStorage(SETTINGS_KEY) ?? {};
        if (THEMES[settings.theme]) {
            this.theme = settings.theme;
        } else {
            this.theme = !userSettings.theme() || userSettings.theme() === 'dark' ? 'dark' : 'light';
        }
        this.fontSize = FONT_SIZES.includes(settings.fontSize) ? settings.fontSize : undefined;
        this.readAloudRate = Number(settings.readAloudRate) || 1;

        screenSaverManager.block();
        loading.show();
        const elem = this.createMediaElement(options);
        return this.setCurrentSrc(elem, options);
    }

    stop() {
        this.unbindEvents();
        this.readAloud?.destroy();
        this.readAloud = null;
        this.tocElement?.();
        this.tocElement = null;
        this.unmountBookOsd?.();
        this.unmountBookOsd = null;
        screenSaverManager.unblock();

        const stopInfo = {
            src: this.item
        };

        Events.trigger(this, 'stopped', [stopInfo]);

        const elem = this.mediaElement;
        if (elem) {
            dialogHelper.close(elem);
            this.mediaElement = null;
        }

        const view = this.view;
        if (view) {
            view.close();
            view.remove();
            this.view = null;
        }

        // hide loader in case player was not fully loaded yet
        loading.hide();
        this.cancellationToken = true;
    }

    destroy() {
        // Nothing to do here
    }

    currentItem() {
        return this.item;
    }

    currentTime() {
        return this.progress * 1000;
    }

    duration() {
        return 1000;
    }

    getBufferedRanges() {
        return [{
            start: 0,
            end: 10000000
        }];
    }

    volume() {
        return 100;
    }

    isMuted() {
        return false;
    }

    paused() {
        return this.readAloud?.state !== ReadAloudState.Playing;
    }

    pause() {
        this.readAloud?.pause();
    }

    unpause() {
        if (!this.loaded || !this.readAloud) return;
        if (this.readAloud.state === ReadAloudState.Paused) {
            void this.readAloud.resume();
        } else if (this.readAloud.state === ReadAloudState.Idle) {
            void this.readAloud.start(ReadAloudMode.Continuous);
        }
    }

    playPause() {
        if (this.paused()) {
            this.unpause();
        } else {
            this.pause();
        }
    }

    rewind() {
        if (this.readAloud && this.readAloud.state !== ReadAloudState.Idle) {
            void this.readAloud.skip(-1);
        } else {
            this.previous();
        }
    }

    fastForward() {
        if (this.readAloud && this.readAloud.state !== ReadAloudState.Idle) {
            void this.readAloud.skip(1);
        } else {
            this.next();
        }
    }

    getSupportedPlaybackRates() {
        return SUPPORTED_PLAYBACK_RATES;
    }

    getPlaybackRate() {
        return this.readAloudRate;
    }

    setPlaybackRate(value) {
        const rate = Number(value);
        if (!rate) return;
        this.readAloudRate = rate;
        writeStorage(SETTINGS_KEY, { ...readStorage(SETTINGS_KEY), readAloudRate: rate });
        void this.readAloud?.setRate(rate);
        this.notifyReadAloud();
    }

    seekable() {
        return true;
    }

    onWindowKeyDown(e) {
        // Skip modified keys
        if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

        const key = keyboardnavigation.getKeyName(e);

        if (!this.loaded) return;
        switch (key) {
            case 'KeyL':
            case 'ArrowRight':
            case 'Right':
                e.preventDefault();
                this.next();
                break;
            case 'KeyJ':
            case 'ArrowLeft':
            case 'Left':
                e.preventDefault();
                this.previous();
                break;
            case 'Escape':
                e.preventDefault();
                if (!this.tocElement) this.stop();
                break;
        }
    }

    onDialogClosed() {
        this.stop();
    }

    bindEvents() {
        this.mediaElement?.addEventListener('close', this.onDialogClosed, { once: true });
        document.addEventListener('keydown', this.onWindowKeyDown);
    }

    unbindEvents() {
        document.removeEventListener('keydown', this.onWindowKeyDown);
        this.mediaElement?.removeEventListener('close', this.onDialogClosed);
    }

    onSectionLoad({ detail: { doc } }) {
        doc.addEventListener('keydown', this.onWindowKeyDown);
        doc.addEventListener('click', this.onDocumentClick);
        // ensure pointer events reach the document for BookOsd visibility listeners
        // eslint-disable-next-line compat/compat
        doc.addEventListener('pointermove', (event) => document.dispatchEvent(new PointerEvent(event.type, event)));
    }

    onDocumentClick(event) {
        if (event.defaultPrevented || event.target?.closest?.('a[href]')) return;
        const selection = event.view?.getSelection?.();
        if (selection && !selection.isCollapsed) return;

        const zone = this.getTapZone(event);
        if (zone < 0) {
            this.previous();
        } else if (zone > 0) {
            this.next();
        } else {
            document.dispatchEvent(new MouseEvent(event.type, event));
        }
    }

    getTapZone(event) {
        const frame = event.view?.frameElement;
        const container = this.mediaElement?.querySelector('#bookPlayerContainer');
        if (!frame || !container) return 0;
        const x = frame.getBoundingClientRect().left + event.clientX;
        const { left, width } = container.getBoundingClientRect();
        const ratio = (x - left) / width;
        if (ratio < TAP_ZONE) return -1;
        if (ratio > 1 - TAP_ZONE) return 1;
        return 0;
    }

    onRelocate({ detail }) {
        const fraction = detail.fraction ?? 0;
        this.progress = fraction;
        if (this.item && detail.cfi) {
            writeStorage(LOCATION_KEY_PREFIX + this.item.Id, { cfi: detail.cfi, fraction });
        }
        this.updateMarginals(detail);
        this.readAloud?.handleRelocate(detail);

        const chapter = detail.tocItem?.label ?? '';
        if (chapter !== this.currentChapter) {
            this.currentChapter = chapter;
            if (this.readAloud && this.readAloud.state !== ReadAloudState.Idle) this.updateReadAloudSession();
        }

        if (this.loaded && this.lastReportedProgress !== fraction) {
            this.lastReportedProgress = fraction;
            Events.trigger(this, 'pause');
        }
    }

    updateMarginals({ tocItem, fraction }) {
        const renderer = this.view?.renderer;
        const heads = renderer?.heads ?? [];
        const feet = renderer?.feet ?? [];
        const chapter = tocItem?.label ?? '';
        const percent = `${Math.round((fraction ?? 0) * 100)}%`;
        heads.forEach((el, i) => {
            el.textContent = i === heads.length - 1 ? chapter : (this.item?.Name ?? '');
        });
        feet.forEach((el, i) => {
            el.textContent = i === feet.length - 1 ? percent : '';
        });
    }

    openTableOfContents() {
        if (!this.loaded) return;

        this.tocElement = renderComponent(BookToc, {
            toc: this.view?.book?.toc ?? [],
            onSelect: (href) => {
                void this.view?.goTo(href);
            },
            onClose: () => {
                this.tocElement();
                this.tocElement = null;
            }
        }, document.querySelector('#bookTocMount'));
    }

    applyTheme() {
        const active = THEMES[this.theme];
        document.documentElement.style.setProperty('--book-theme-color', active.body.color);
        document.documentElement.style.setProperty('--book-theme-background', active.body.background);
        this.view?.renderer?.setStyles?.(getStyles(this.theme, this.fontSize));
        if (this.readAloud) this.readAloud.color = active.highlight;
    }

    setTheme(theme, fontSize) {
        if (!this.loaded) return;

        this.theme = theme;
        this.fontSize = fontSize;
        writeStorage(SETTINGS_KEY, { ...readStorage(SETTINGS_KEY), theme, fontSize });
        this.applyTheme();
    }

    rotateTheme() {
        this.setTheme(THEME_ORDER[(THEME_ORDER.indexOf(this.theme) + 1) % THEME_ORDER.length], this.fontSize);
    }

    increaseFontSize() {
        if (this.fontSize === FONT_SIZES[FONT_SIZES.length - 1]) return;

        this.setTheme(this.theme, FONT_SIZES[(FONT_SIZES.indexOf(this.fontSize ?? 'medium') + 1)]);
    }

    decreaseFontSize() {
        if (this.fontSize === FONT_SIZES[0]) return;

        this.setTheme(this.theme, FONT_SIZES[(FONT_SIZES.indexOf(this.fontSize ?? 'medium') - 1)]);
    }

    previous(e) {
        e?.preventDefault?.();
        void this.view?.goLeft();
    }

    next(e) {
        e?.preventDefault?.();
        void this.view?.goRight();
    }

    async openReadAloudMenu(anchor) {
        if (!this.loaded || !this.readAloud) return;

        const items = [
            { id: ReadAloudMode.Continuous, name: globalize.translate('ReadAloudFromHere'), icon: 'record_voice_over' },
            { id: ReadAloudMode.Page, name: globalize.translate('ReadAloudPage'), icon: 'description' },
            { id: ReadAloudMode.Chapter, name: globalize.translate('ReadAloudChapter'), icon: 'menu_book' }
        ];
        if (this.readAloud.hasSettings) {
            items.push({ id: 'settings', name: globalize.translate('ReadAloudVoiceSettings'), icon: 'settings_voice' });
        }

        let id;
        try {
            id = await actionsheet.show({ items, positionTo: anchor, title: globalize.translate('ReadAloud') });
        } catch {
            return;
        }

        if (id === 'settings') {
            await this.readAloud?.openSettings();
        } else if (Object.values(ReadAloudMode).includes(id)) {
            await this.readAloud?.start(id);
        }
    }

    async openReadAloudRateMenu(anchor) {
        const items = SUPPORTED_PLAYBACK_RATES.map(rate => ({
            id: String(rate.id),
            name: rate.name,
            selected: rate.id === this.readAloudRate
        }));

        try {
            const id = await actionsheet.show({ items, positionTo: anchor });
            if (id) this.setPlaybackRate(parseFloat(id));
        } catch {
            // menu dismissed
        }
    }

    toggleReadAloud() {
        void this.readAloud?.togglePause();
    }

    stopReadAloud() {
        this.readAloud?.stop();
    }

    notifyReadAloud() {
        this.readAloudEvents.dispatchEvent(new CustomEvent('change', {
            detail: {
                state: this.readAloud?.state ?? ReadAloudState.Idle,
                rate: this.readAloudRate
            }
        }));
    }

    updateReadAloudSession() {
        if (!window.NativeShell?.tts?.updateSession || !this.item) return;
        window.NativeShell.tts.updateSession({
            state: this.readAloud?.state ?? ReadAloudState.Idle,
            title: this.item.Name,
            subtitle: this.currentChapter ?? '',
            imageUrl: getImageUrl(this.item, { maxHeight: 512 })
        });
    }

    onReadAloudStateChange() {
        this.notifyReadAloud();
        this.updateReadAloudSession();
        Events.trigger(this, this.readAloud?.state === ReadAloudState.Playing ? 'unpause' : 'pause');
    }

    onReadAloudError({ detail }) {
        toast(globalize.translate(detail === 'unavailable' ? 'ReadAloudUnavailable' : 'ReadAloudError'));
    }

    createMediaElement(options) {
        let elem = this.mediaElement;
        if (elem) {
            return elem;
        }

        elem = document.getElementById('bookPlayer');
        if (!elem) {
            elem = dialogHelper.createDialog({
                exitAnimationDuration: 400,
                size: 'fullscreen',
                autoFocus: false,
                scrollY: false,
                exitAnimation: 'fadeout',
                removeOnClose: true
            });

            elem.id = 'bookPlayer';
            elem.innerHTML = translateHtml(html);

            dialogHelper.open(elem);
        }

        this.mediaElement = elem;
        this.unmountBookOsd = renderComponent(BookOsd, {
            item: options.items[0],
            onExit: this.onDialogClosed,
            onPrevious: this.previous,
            onNext: this.next,
            onOpenTableOfContents: this.openTableOfContents,
            onRotateTheme: this.rotateTheme,
            onDecreaseFontSize: this.decreaseFontSize,
            onIncreaseFontSize: this.increaseFontSize,
            readAloudEvents: this.readAloudEvents,
            initialReadAloudRate: this.readAloudRate,
            onReadAloud: this.openReadAloudMenu,
            onReadAloudToggle: this.toggleReadAloud,
            onReadAloudStop: this.stopReadAloud,
            onReadAloudPrevious: this.rewind,
            onReadAloudNext: this.fastForward,
            onReadAloudRate: this.openReadAloudRateMenu
        }, elem.querySelector('#bookOsdMount'));

        return elem;
    }

    async setCurrentSrc(elem, options) {
        const item = options.items[0];
        this.item = item;
        this.streamInfo = {
            started: true,
            ended: false,
            item: this.item,
            mediaSource: {
                Id: item.Id
            }
        };

        try {
            const api = ServerConnections.getApi(item.ServerId);
            if (!api) throw new Error(`no Api instance available for server ${item.ServerId}`);

            const downloadHref = getLibraryApi(api).getDownloadUrl({ itemId: item.Id });
            this.currentSrc = () => downloadHref;

            const [{ makeBook, View }, file] = await Promise.all([
                import('lib/foliate-js/view.js'),
                fetchBook(downloadHref, item)
            ]);
            if (this.cancellationToken) return;

            const book = await makeBook(file);
            blockScripts(book);
            if (this.cancellationToken) return;

            const view = new View();
            view.className = 'bookView';
            this.view = view;
            view.addEventListener('load', this.onSectionLoad);
            view.addEventListener('relocate', this.onRelocate);
            elem.querySelector('#bookPlayerContainer').append(view);
            await view.open(book);

            view.renderer.setAttribute('flow', 'paginated');
            view.renderer.setAttribute('animated', '');
            this.applyTheme();

            this.readAloud = new ReadAloud(view, {
                rate: this.readAloudRate,
                color: THEMES[this.theme].highlight,
                lang: view.language?.canonical
            });
            this.readAloud.addEventListener('statechange', this.onReadAloudStateChange);
            this.readAloud.addEventListener('error', this.onReadAloudError);
            this.bindEvents();

            const startFraction = (options.startPositionTicks || 0) / 10000000;
            await view.init({ lastLocation: getResumeLocation(item.Id, startFraction) });
            if (this.cancellationToken) return;

            this.loaded = true;
            this.notifyReadAloud();
            loading.hide();
        } catch (err) {
            console.error('[BookPlayer] failed to display book', err);
            loading.hide();
            throw err;
        }
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'book';
    }

    canPlayItem(item) {
        const path = item.Path?.toLowerCase();
        return !!path && SUPPORTED_EXTENSIONS.some(ext => path.endsWith(ext));
    }
}

export default BookPlayer;
