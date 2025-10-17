import { dvi2html } from '@drgrice1/dvi2html';
import { expose } from 'threads/worker';
import pako from 'pako';
import { Buffer } from 'buffer';
import { Writable } from 'stream-browserify';
import * as library from './library';

let coredump;
let code;
let urlRoot;

const loadDecompress = async (file) => {
    const response = await fetch(`${urlRoot}/${file}`);
    if (response.ok) {
        const reader = response.body.getReader();
        const inflate = new pako.Inflate();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            inflate.push(value);
        }
        reader.releaseLock();
        if (inflate.err) throw new Error(inflate.err);

        return inflate.result;
    } else {
        throw new Error(`Unable to load ${file}. File not available.`);
    }
};

function getUnicode(char) {
    const code = char.codePointAt(0);
    return 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
}

function fromUnicode(code) {
    // support：U+4E2D, U+1F600, 4E2D, 0x4E2D
    const match = code.match(/(?:U\+|0x)?([0-9A-Fa-f]+)/);
    if (!match) {
        throw new Error('Invalid Unicode code point: ' + code);
    }
    const hex = match[1];
    const codePoint = parseInt(hex, 16);
    return String.fromCodePoint(codePoint);
}

function findNotSupportedChars(str) {
    const result = [];
    for (let char of str) {
        const code = char.codePointAt(0);
        if (code > 255) {
            result.push(char);
        }
    }
    return result;
}

function replaceNotSupportedCharMarkers(str) {
    // match PUA [U+xxxx]
    // const regex = /&#xf05b;&#xf055;&#xf02b;(&#xf0[0-9a-f]{2};){4}&#xf05d;/gi;
    // add (?:[^&]|&(?!(#xf[0-9a-f]{3};)))*? to adapt to broken marker
    const anyNotPUA = `(?:[^&]|&(?!(#xf[0-9a-f]{3};)))*?`;
    const regex = new RegExp(
        '&#xf05b;' +     // [
        anyNotPUA +
        '&#xf055;' +     // U
        anyNotPUA +
        '&#xf02b;' +     // +
        `(${anyNotPUA}&#xf0[0-9a-f]{2};){4}` + // 四个十六进制字符
        anyNotPUA +
        '&#xf05d;',      // ]
        'gi'
    );

    return str.replace(regex, (match) => {
        // extract four &#x...;
        let entities = match.toLowerCase().match(/&#xf0[0-9a-f]{2};/gi) || [];
        if (entities.length != 8) return match;
        entities = entities.slice(3, 7);
        let unicode = 'U+';
        for (const entity of entities) {
            const hexCode = entity.slice(3); // remove &#x
            const code = parseInt(hexCode, 16);
            unicode += String.fromCharCode(code & 0xFF).toUpperCase();
        }

        return fromUnicode(unicode);
    });
}

expose({
    async load(_urlRoot) {
        urlRoot = _urlRoot;
        code = await loadDecompress('tex.wasm.gz');
        coredump = new Uint8Array(await loadDecompress('core.dump.gz'), 0, library.pages * 65536);
    },
    async texify(input, dataset) {
        // Set up the tex input file.
        const texPackages = dataset.texPackages ? JSON.parse(dataset.texPackages) : {};

        input = input.split('\n').filter(line => line.trim()).join('\n'); // remove empty line
        const unsupportChars = findNotSupportedChars(input); // find all not supported char
        input =
            '\\tikzset{every matrix/.append style={nodes in empty cells}}\n' +
            Object.entries(texPackages).reduce((usePackageString, thisPackage) => {
                usePackageString +=
                    '\\usepackage' + (thisPackage[1] ? `[${thisPackage[1]}]` : '') + `{${thisPackage[0]}}\n`;
                return usePackageString;
            }, '') +
            (dataset.tikzLibraries ? `\\usetikzlibrary{${dataset.tikzLibraries}}\n` : '') +
            (dataset.addToPreamble || '') +
            (unsupportChars.length > 0 ? '\\usepackage{newunicodechar}\n' : '') +
            unsupportChars.reduce((newunicodecharString, char) => {
                newunicodecharString +=
                    `\\newunicodechar{${char}}{\\rlap{[${getUnicode(char)}]}\\phantom{xx}}\n`;
                return newunicodecharString;
            }, '') +
            (input.match(/(\\begin\s*\{\s*document\s*\})/i) ? input : `\\begin{document}\n${input}\n\\end{document}\n`);

        if (dataset.showConsole) library.setShowConsole();

        library.writeFileSync('input.tex', Buffer.from(input));

        // Set up the tex web assembly.
        const memory = new WebAssembly.Memory({ initial: library.pages, maximum: library.pages });

        const buffer = new Uint8Array(memory.buffer, 0, library.pages * 65536);
        buffer.set(coredump.slice(0));

        library.setMemory(memory.buffer);
        library.setInput('input.tex\n\\end\n');
        library.setFileLoader(loadDecompress);

        const wasm = await WebAssembly.instantiate(code, { library, env: { memory } });

        // Execute the tex web assembly.
        await library.executeAsync(wasm.instance.exports);

        // Extract the generated log file.
        let log = library.readFileSync('input.log').buffer;
        log = new TextDecoder('utf-8').decode(log);

        let dvi = null;
        try {
            // Extract the generated dvi file.
            dvi = library.readFileSync('input.dvi').buffer;
        } catch (err) { // eslint-disable-line no-unused-vars
            // Clean up the library for the next run.
            library.deleteEverything();
            throw new Error("fail to generate dvi, log:\n" + log);
        }

        // Clean up the library for the next run.
        library.deleteEverything();

        // Use dvi2html to convert the dvi to svg.
        let html = '';
        const page = new Writable({
            write(chunk, _encoding, callback) {
                html = html + chunk.toString();
                callback();
            }
        });

        async function* streamBuffer() {
            yield Buffer.from(dvi);
            return;
        }

        await dvi2html(streamBuffer(), page);

        html = replaceNotSupportedCharMarkers(html);

        return html;
    }
});
