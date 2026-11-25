import { describe, expect, it } from 'vitest';

import { parseSsml } from './ssml';

const SSML_HEADER = '<speak xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en">';

describe('parseSsml', () => {
    it('maps every mark to the offset of the word that follows it', () => {
        const { text, marks, lang } = parseSsml(
            `${SSML_HEADER}<mark name="0"/>The <mark name="1"/>keeper\n   <emphasis><mark name="2"/>watched</emphasis> <mark name="3"/>it.</speak>`
        );

        expect(text).toBe('The keeper watched it.');
        expect(lang).toBe('en');
        expect(marks.map(m => [m.name, text.slice(m.offset).split(' ')[0]])).toEqual([
            ['0', 'The'],
            ['1', 'keeper'],
            ['2', 'watched'],
            ['3', 'it.']
        ]);
    });

    it('collapses leading whitespace and turns breaks into spaces', () => {
        const { text, marks } = parseSsml(
            `${SSML_HEADER}\n  <mark name="0"/>Line<break/><mark name="1"/>two</speak>`
        );

        expect(text).toBe('Line two');
        expect(marks).toEqual([
            { name: '0', offset: 0 },
            { name: '1', offset: 5 }
        ]);
    });
});
