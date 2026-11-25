const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface SsmlMark {
    name: string;
    offset: number;
}

export interface ParsedSsml {
    text: string;
    marks: SsmlMark[];
    lang: string | null;
}

export function parseSsml(ssml: string): ParsedSsml {
    const doc = new DOMParser().parseFromString(ssml, 'application/xml');
    const root = doc.documentElement;
    const marks: SsmlMark[] = [];
    let text = '';

    const append = (str: string) => {
        let collapsed = str.replace(/\s+/g, ' ');
        if (collapsed.startsWith(' ') && (!text || text.endsWith(' '))) collapsed = collapsed.slice(1);
        text += collapsed;
    };

    const walk = (node: Node) => {
        for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
                append(child.nodeValue ?? '');
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                const el = child as Element;
                if (el.localName === 'mark') {
                    marks.push({ name: el.getAttribute('name') ?? '', offset: text.length });
                } else if (el.localName === 'break') {
                    append(' ');
                } else {
                    walk(el);
                }
            }
        }
    };

    walk(root);
    return { text, marks, lang: root.getAttributeNS(XML_NS, 'lang') || null };
}
