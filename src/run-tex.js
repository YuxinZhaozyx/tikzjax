import { dvi2html } from '@yuxinzhao/dvi2html';
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
    const anyNotPUA = '(?:[^&]|&(?!(#xf[0-9a-f]{3};)))*?';
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

async function embedFonts(html) {
    // 1. 提取所有 font-family 名称
    const fontFamilyRegex = /font-family\s*=\s*["']?([^;"']+)["']?/gi;
    const matches = [...html.matchAll(fontFamilyRegex)];
    const fontFamilies = [...new Set(matches.map(m => m[1].trim()))]; // 去重

    if (fontFamilies.length === 0) {
        return html; // 没有字体，直接返回
    }

    // 2. 加载字体并转换为 base64
    const fontFaces = [];

    for (const fontFamily of fontFamilies) {
        const filename = `${fontFamily}.woff2`;
        const url = `${urlRoot}/fonts/${filename}`;

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const reader = response.body.getReader();
            const chunks = [];
            let done, value;
            while (!done) {
                ({ done, value } = await reader.read());
                if (value) chunks.push(value);
            }

            // 合并所有 chunk
            const uint8Array = new Uint8Array(chunks.reduce((acc, chunk) => {
                const newAcc = new Uint8Array(acc.length + chunk.length);
                newAcc.set(acc);
                newAcc.set(chunk, acc.length);
                return newAcc;
            }, new Uint8Array()));

            // 转为 base64
            const base64 = btoa(String.fromCharCode(...uint8Array));
            const fontFaceCSS = '@font-face' +
                `{ font-family:"${fontFamily}"; src:url(data:font/woff2;base64,${base64}) format('woff2'); }`;
            fontFaces.push(fontFaceCSS);
        } catch (err) {
            console.warn(`load font fail: ${fontFamily}`, err);
        }
    }

    if (fontFaces.length === 0) {
        return html; // 没有成功加载任何字体
    }

    // 3. 构造 style 标签
    const styleTag = `<style>${fontFaces.join('\n')}</style>\n`;

    // 4. 在 <svg> 开始标签后插入 <style>
    // 匹配 <svg ...> 或 <svg>，并保留所有属性
    const svgOpenTagMatch = html.match(/<svg[^>]*>/);
    if (!svgOpenTagMatch) {
        // HTML 中未找到 <svg> 标签
        return html;
    }

    const svgOpenTag = svgOpenTagMatch[0];
    const insertIndex = svgOpenTagMatch.index + svgOpenTag.length;

    // 插入 style，并确保只插入一次
    const result = html.slice(0, insertIndex) + styleTag + html.slice(insertIndex);

    return result;
}

function composeToSVG(html) {
    // 匹配所有 <svg> 开始标签和内容
    const svgRegex = /<svg\b[^>]*>(.*?)<\/svg>/gs;
    const matches = [];
    let match;

    // 提取所有 <svg> 的内容
    while ((match = svgRegex.exec(html)) !== null) {
        matches.push(match);
    }

    if (matches.length === 0) return '';

    // 第一个 match[0] 是完整标签，match[1] 是内容
    const firstMatch = matches[0];
    const firstTag = firstMatch[0]; // 完整的首个 <svg...> 标签
    const contentParts = matches.map(m => m[1]); // 所有内容部分

    // 合并内容
    const mergedContent = contentParts.join('');

    // 从第一个标签中提取开标签部分（不含内容）
    // 我们要保留第一个 <svg ...> 的开标签结构
    const openTagMatch = firstTag.match(/<svg\b[^>]*>/i);
    if (!openTagMatch) return '';

    const openTag = openTagMatch[0];
    const closingTag = '</svg>';

    // 拼接最终结果
    return `${openTag}${mergedContent}${closingTag}`;
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
        input = input.split('\n').filter(line => line.trim() && !line.includes('\\documentclass')).join('\n'); // remove empty line and documentclass
        const unsupportChars = findNotSupportedChars(input); // find all not supported char

        const match = input.match(/\\begin\s*\{\s*document\s*\}/i);
        let head = '';
        let body = '';
        if (match) {
            const index = match.index;
            head = input.substring(0, index);
            body = input.substring(index);
        } else {
            head = '';
            body = `\\begin{document}\n${input}\n\\end{document}\n`;
        }

        head =
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
            head;

        if (head.match(/^(?:[^%\n]|\\%)*?\\usepackage(?:\[[^\]]*\])?\s*\{\s*tikz-cd\s*\}/im)) {
            head += '\\tikzcdset{nodes in empty cells}\n';
        }

        input = head + body;

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
            throw new Error('fail to generate dvi, log:\n' + log);
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
        html = composeToSVG(html);
        if (dataset.embedFonts) html = embedFonts(html);

        return html;
    }
});
