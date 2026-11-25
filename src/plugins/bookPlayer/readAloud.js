import { Overlayer } from 'lib/foliate-js/overlayer.js';
import { parseSsml } from 'utils/ssml';

const HIGHLIGHT_KEY = 'read-aloud';

export const ReadAloudState = {
    Idle: 'idle',
    Playing: 'playing',
    Paused: 'paused'
};

export const ReadAloudMode = {
    Continuous: 'continuous',
    Page: 'page',
    Chapter: 'chapter'
};

function findMark(marks, charIndex) {
    let lo = 0;
    let hi = marks.length - 1;
    let found = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].offset <= charIndex) {
            found = marks[mid];
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found ?? marks[0] ?? null;
}

function splitSentences(text, lang) {
    try {
        const segmenter = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
        return Array.from(segmenter.segment(text))
            .filter(({ segment }) => segment.trim())
            .map(({ segment, index }) => ({ text: segment, offset: index }));
    } catch {
        return [{ text, offset: 0 }];
    }
}

class NativeSpeechEngine {
    static isAvailable() {
        return !!window.NativeShell?.tts;
    }

    constructor(onEvent) {
        this.listener = e => onEvent(e.detail);
        window.addEventListener('nativetts', this.listener);
    }

    get hasSettings() {
        return !!window.NativeShell.tts.openSettings;
    }

    openSettings() {
        window.NativeShell.tts.openSettings();
    }

    speak(id, text, lang, rate) {
        window.NativeShell.tts.speak({ id, text, lang, rate });
    }

    stop() {
        window.NativeShell.tts.stop();
    }

    destroy() {
        window.removeEventListener('nativetts', this.listener);
        window.NativeShell.tts.release?.();
    }
}

class WebSpeechEngine {
    static async isAvailable() {
        if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return false;
        if (speechSynthesis.getVoices().length) return true;
        return new Promise(resolve => {
            const done = () => resolve(speechSynthesis.getVoices().length > 0);
            const timeout = setTimeout(done, 1500);
            speechSynthesis.addEventListener('voiceschanged', () => {
                clearTimeout(timeout);
                done();
            }, { once: true });
        });
    }

    constructor(onEvent) {
        this.onEvent = onEvent;
    }

    get hasSettings() {
        return false;
    }

    getVoice(lang) {
        if (!lang) return null;
        const voices = speechSynthesis.getVoices();
        const tag = lang.toLowerCase().replace('_', '-');
        const base = tag.split('-')[0];
        const normalize = v => v.lang.toLowerCase().replace('_', '-');
        return voices.find(v => normalize(v) === tag && v.default)
            || voices.find(v => normalize(v) === tag)
            || voices.find(v => normalize(v).split('-')[0] === base)
            || null;
    }

    speak(id, text, lang, rate) {
        speechSynthesis.cancel();
        const parts = splitSentences(text, lang);
        if (!parts.length) {
            setTimeout(() => this.onEvent({ type: 'end', id }));
            return;
        }

        const voice = this.getVoice(lang);
        parts.forEach((part, i) => {
            // eslint-disable-next-line compat/compat
            const utterance = new SpeechSynthesisUtterance(part.text);
            if (lang) utterance.lang = lang;
            if (voice) utterance.voice = voice;
            utterance.rate = rate;
            utterance.onstart = () => this.onEvent({ type: 'boundary', id, charIndex: part.offset });
            utterance.onboundary = e => {
                if (!e.name || e.name === 'word') {
                    this.onEvent({ type: 'boundary', id, charIndex: part.offset + e.charIndex });
                }
            };
            utterance.onerror = e => {
                if (e.error !== 'interrupted' && e.error !== 'canceled') {
                    this.onEvent({ type: 'error', id, message: e.error });
                }
            };
            if (i === parts.length - 1) utterance.onend = () => this.onEvent({ type: 'end', id });
            speechSynthesis.speak(utterance);
        });
    }

    stop() {
        speechSynthesis.cancel();
    }

    destroy() {
        speechSynthesis.cancel();
    }
}

export class ReadAloud extends EventTarget {
    #view;
    #engine = null;
    #enginePromise = null;
    #tts = null;
    #marks = [];
    #utteranceId = null;
    #counter = 0;
    #state = ReadAloudState.Idle;
    #mode = ReadAloudMode.Continuous;
    #pageRange = null;
    #lastRange = null;
    #following = false;
    #changingSection = false;
    #rate;
    #resumeOnFocus = false;
    #color;
    #lang;

    constructor(view, { rate = 1, color = '#00a4dc', lang } = {}) {
        super();
        this.#view = view;
        this.#rate = rate;
        this.#color = color;
        this.#lang = lang;
    }

    static async isSupported() {
        return NativeSpeechEngine.isAvailable() || WebSpeechEngine.isAvailable();
    }

    get state() {
        return this.#state;
    }

    get mode() {
        return this.#mode;
    }

    get rate() {
        return this.#rate;
    }

    get hasSettings() {
        return !!this.#engine?.hasSettings || NativeSpeechEngine.isAvailable();
    }

    set color(color) {
        this.#color = color;
        if (this.#lastRange && this.#state !== ReadAloudState.Idle) this.#draw(this.#lastRange);
    }

    async openSettings() {
        const engine = await this.#getEngine();
        if (engine?.hasSettings) engine.openSettings();
    }

    async start(mode = ReadAloudMode.Continuous) {
        this.#resumeOnFocus = false;
        const engine = await this.#getEngine();
        if (!engine) return false;

        this.#cancelSpeech();
        this.#mode = mode;
        const visible = this.#view.lastLocation?.range;
        this.#pageRange = mode === ReadAloudMode.Page ? visible?.cloneRange() : null;

        await this.#initTts();
        let ssml;
        if (mode === ReadAloudMode.Chapter || !visible) {
            ssml = this.#tts.start();
        } else {
            try {
                ssml = this.#tts.from(visible);
            } catch {
                ssml = this.#tts.start();
            }
        }

        this.#setState(ReadAloudState.Playing);
        await this.#speakFrom(ssml);
        return true;
    }

    pause() {
        this.#resumeOnFocus = false;
        if (this.#state !== ReadAloudState.Playing) return;
        this.#cancelSpeech();
        this.#setState(ReadAloudState.Paused);
    }

    async resume() {
        if (this.#state !== ReadAloudState.Paused) return;
        if (!this.#tts || this.#position(this.#lastRange) !== 0) {
            await this.start(this.#mode === ReadAloudMode.Page ? ReadAloudMode.Page : ReadAloudMode.Continuous);
            return;
        }
        this.#setState(ReadAloudState.Playing);
        await this.#speakFrom(this.#tts.resume());
    }

    async togglePause() {
        if (this.#state === ReadAloudState.Playing) this.pause();
        else if (this.#state === ReadAloudState.Paused) await this.resume();
        else await this.start();
    }

    async skip(direction) {
        if (this.#state === ReadAloudState.Idle || !this.#tts) return;
        this.#cancelSpeech();
        this.#pageRange = null;
        this.#setState(ReadAloudState.Playing);
        const ssml = direction < 0 ? (this.#tts.prev() ?? this.#tts.start()) : this.#tts.next();
        await this.#speakFrom(ssml);
    }

    async setRate(rate) {
        this.#rate = rate;
        this.#emit('ratechange');
        if (this.#state === ReadAloudState.Playing && this.#tts) {
            this.#cancelSpeech();
            await this.#speakFrom(this.#tts.resume());
        }
    }

    stop() {
        this.#resumeOnFocus = false;
        if (this.#state === ReadAloudState.Idle) return;
        this.#cancelSpeech();
        this.#clearHighlight();
        this.#pageRange = null;
        this.#lastRange = null;
        this.#setState(ReadAloudState.Idle);
    }

    destroy() {
        this.stop();
        this.#engine?.destroy();
        this.#engine = null;
    }

    handleRelocate({ range }) {
        if (this.#state !== ReadAloudState.Playing || this.#changingSection || !range || !this.#tts) return;
        if (range.startContainer.ownerDocument !== this.#tts.doc) {
            this.start(this.#mode === ReadAloudMode.Page ? ReadAloudMode.Page : ReadAloudMode.Continuous)
                .catch(err => console.error('[ReadAloud] failed to restart after navigation', err));
        }
    }

    #emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    #setState(state) {
        if (this.#state === state) return;
        this.#state = state;
        this.#emit('statechange', state);
    }

    async #getEngine() {
        if (this.#engine) return this.#engine;
        this.#enginePromise ??= (async () => {
            const onEvent = detail => this.#onEngineEvent(detail);
            if (NativeSpeechEngine.isAvailable()) return new NativeSpeechEngine(onEvent);
            if (await WebSpeechEngine.isAvailable()) return new WebSpeechEngine(onEvent);
            return null;
        })();
        this.#engine = await this.#enginePromise;
        if (!this.#engine) {
            this.#enginePromise = null;
            this.#emit('error', 'unavailable');
        }
        return this.#engine;
    }

    async #initTts() {
        const doc = this.#view.renderer.getContents()[0]?.doc;
        if (this.#tts && this.#tts.doc === doc) return;
        this.#view.tts = null;
        await this.#view.initTTS('word', range => this.#highlight(range));
        this.#tts = this.#view.tts;
    }

    #cancelSpeech() {
        this.#utteranceId = null;
        this.#engine?.stop();
    }

    async #speakFrom(ssml) {
        for (let guard = 0; guard < 10000 && this.#state === ReadAloudState.Playing; guard++) {
            if (ssml) {
                const { text, marks, lang } = parseSsml(ssml);
                if (text.trim()) {
                    this.#marks = marks;
                    const id = String(++this.#counter);
                    this.#utteranceId = id;
                    if (marks.length) this.#tts.setMark(marks[0].name);
                    if (this.#state !== ReadAloudState.Playing) return;
                    this.#engine.speak(id, text, lang || this.#lang || '', this.#rate);
                    return;
                }
                ssml = this.#tts.next();
                continue;
            }

            if (this.#mode !== ReadAloudMode.Continuous || !(await this.#nextSection())) {
                this.stop();
                return;
            }
            if (this.#state !== ReadAloudState.Playing) return;
            ssml = this.#tts.start();
        }
    }

    async #nextSection() {
        const renderer = this.#view.renderer;
        const current = renderer.getContents()[0]?.index;
        const sections = this.#view.book.sections;
        const target = sections.findIndex((s, i) => i > current && s.linear !== 'no');
        if (current == null || target < 0) return false;

        this.#changingSection = true;
        try {
            for (let attempt = 0; attempt < 5; attempt++) {
                await renderer.goTo({ index: target });
                if (renderer.getContents()[0]?.index === target) break;
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } finally {
            this.#changingSection = false;
        }

        if (renderer.getContents()[0]?.index !== target) return false;
        await this.#initTts();
        return true;
    }

    #onEngineEvent({ type, id, charIndex, message, transient, action }) {
        if (type === 'command') {
            this.#onCommand(action);
            return;
        }
        if (type === 'interrupted') {
            const wasPlaying = this.#state === ReadAloudState.Playing;
            this.pause();
            this.#resumeOnFocus = wasPlaying && !!transient;
            return;
        }
        if (type === 'resume') {
            const shouldResume = this.#resumeOnFocus;
            this.#resumeOnFocus = false;
            if (shouldResume) {
                this.resume().catch(err => console.error('[ReadAloud] failed to resume', err));
            }
            return;
        }
        if (id !== this.#utteranceId || this.#state !== ReadAloudState.Playing) return;

        switch (type) {
            case 'boundary': {
                const mark = findMark(this.#marks, charIndex);
                if (mark) this.#tts.setMark(mark.name);
                break;
            }
            case 'end':
                this.#utteranceId = null;
                this.#speakFrom(this.#tts.next())
                    .catch(err => console.error('[ReadAloud] failed to continue', err));
                break;
            case 'error':
                console.error('[ReadAloud] speech engine error', message);
                this.stop();
                this.#emit('error', message);
                break;
        }
    }

    #onCommand(action) {
        const run = {
            play: () => (this.#state === ReadAloudState.Paused ? this.resume() : this.start()),
            pause: () => this.pause(),
            next: () => this.skip(1),
            previous: () => this.skip(-1),
            stop: () => this.stop()
        }[action];
        Promise.resolve(run?.()).catch(err => console.error('[ReadAloud] command failed', action, err));
    }

    #highlight(range) {
        if (this.#state !== ReadAloudState.Playing) return;
        if (this.#isPastPage(range)) {
            this.stop();
            return;
        }
        this.#lastRange = range;
        this.#draw(range);
        this.#follow();
    }

    #isPastPage(range) {
        if (!this.#pageRange) return false;
        try {
            return compareStartToEnd(range, this.#pageRange) >= 0;
        } catch {
            return false;
        }
    }

    #draw(range) {
        const contents = this.#view.renderer.getContents()[0];
        if (contents?.overlayer && contents.doc === range.startContainer.ownerDocument) {
            contents.overlayer.add(HIGHLIGHT_KEY, range, Overlayer.highlight, { color: this.#color });
        }
    }

    #clearHighlight() {
        for (const { overlayer } of this.#view.renderer?.getContents() ?? []) {
            overlayer?.remove(HIGHLIGHT_KEY);
        }
    }

    #position(range) {
        const visible = this.#view.lastLocation?.range;
        if (!range || !visible) return null;
        try {
            if (compareStartToEnd(range, visible) >= 0) return 1;
            if (range.compareBoundaryPoints(Range.START_TO_END, visible) <= 0) return -1;
            return 0;
        } catch {
            return null;
        }
    }

    async #follow() {
        if (this.#following) return;
        this.#following = true;
        const renderer = this.#view.renderer;
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                const range = this.#lastRange;
                const position = this.#position(range);
                if (!position || this.#state !== ReadAloudState.Playing) break;
                const onLastPage = renderer.page >= renderer.pages - 2;
                if (position > 0 && attempt === 0 && !onLastPage) {
                    await renderer.next();
                } else {
                    await renderer.scrollToAnchor(range);
                }
            }
        } catch (err) {
            console.warn('[ReadAloud] failed to keep the spoken word in view', err);
        } finally {
            this.#following = false;
        }
    }
}

function compareStartToEnd(range, other) {
    return range.compareBoundaryPoints(Range.END_TO_START, other);
}
