/*
    Integration tests against a strict S7 PLC simulator (test/integration/s7-sim.py,
    python-snap7 server started with uv). Run with: npm run test:integration
    NODES7_DIR can point to another nodes7 build to compare (e.g. an upstream release).
*/
const { expect } = require('chai');
const path = require('path');
const { spawn } = require('child_process');

const lib = require(process.env.NODES7_DIR || path.join(__dirname, '..', '..'));
const { S7Endpoint, S7ItemGroup } = lib;
const PORT = 14000 + Math.floor(Math.random() * 1000);

describe('S7 PLC simulator integration', function () {
    this.timeout(60000);
    let plc, endpoint;

    before(async () => {
        plc = spawn('uv', ['run', '--quiet', '--with', 'python-snap7', 'python', path.join(__dirname, 's7-sim.py'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
        await new Promise((resolve, reject) => {
            plc.stdout.on('data', d => { if (/S7 sim on/.test(d)) resolve(); });
            plc.on('exit', code => reject(new Error(`simulator exited (${code})`)));
        });
        endpoint = new S7Endpoint({ host: '127.0.0.1', port: PORT, rack: 0, slot: 2 });
        endpoint.on('error', () => {});
        await new Promise((resolve, reject) => { endpoint.once('connect', resolve); setTimeout(() => reject(new Error('connect timeout')), 10000); });
    });

    after(async () => {
        if (endpoint) await endpoint.disconnect();
        if (plc) plc.kill();
    });

    function group(tags) {
        const g = new S7ItemGroup(endpoint);
        g.setTranslationCB(t => t);
        g.addItems(tags);
        return g;
    }

    it('writes several odd-length items in one request and reads them back (#16)', async () => {
        const tags = ['DB1,BYTE40', 'DB1,BYTE41', 'DB1,BYTE43', 'DB1,X50.3', 'DB1,INT52', 'DB1,REAL56'];
        const g = group(tags);
        await g.writeItems(tags, [0, 0, 0, false, 0, 0]);
        await g.writeItems(tags, [0x11, 0x22, 0x33, true, -1234, 2.5]);
        expect(await g.readAllItems()).to.deep.equal({ 'DB1,BYTE40': 0x11, 'DB1,BYTE41': 0x22, 'DB1,BYTE43': 0x33, 'DB1,X50.3': true, 'DB1,INT52': -1234, 'DB1,REAL56': 2.5 });
    });

    it('leaves the neighbouring bytes alone', async () => {
        const g = group(['DB1,BYTE42', 'DB1,BYTE44']);
        expect(await g.readAllItems()).to.deep.equal({ 'DB1,BYTE42': 0, 'DB1,BYTE44': 0 });
    });

    it('writes 120 booleans at once, split into requests that fit the PDU (#8)', async () => {
        const tags = [];
        for (let i = 0; i < 120; i++) tags.push(`DB1,X${100 + Math.floor(i / 8)}.${i % 8}`);
        const g = group(tags);
        const values = tags.map((_, i) => i % 3 === 0);
        await g.writeItems(tags, values.map(v => !v));
        await g.writeItems(tags, values);
        const read = await g.readAllItems();
        expect(tags.map(t => read[t])).to.deep.equal(values);
    });

    it('reads 40 odd-length parts without exceeding the PDU (#17)', async () => {
        const tags = [];
        for (let i = 0; i < 40; i++) tags.push(`DB1,B${1000 + i * 42}.21`);
        const g = group(tags);
        const data = tags.map((_, i) => Array.from({ length: 21 }, (__, j) => (i + j) % 256));
        await g.writeItems(tags, data);
        const read = await g.readAllItems();
        expect(tags.map(t => Array.from(read[t]))).to.deep.equal(data);
    });
});
