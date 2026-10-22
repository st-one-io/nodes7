/*
    Regression tests for the S7 fill bytes ("padding") that follow odd-length data items.

    S7comm puts a fill byte after every odd-length data item except the last one, both in
    WriteVar requests and in ReadVar responses (see the Wireshark s7comm dissector).
    - #16: since 1.1.2 multi-item write requests were sent without fill bytes (PLC error 0x8104)
    - #8:  writeItems() split requests without counting fill bytes, exceeding the PDU size
    - #17: the read optimizer did not count fill bytes in responses (PLC error 0x8500)
*/

const { expect } = require('chai');
const constants = require('../../src/constants.json');
const S7Serializer = require('../../src/s7protocol/s7serializer.js');
const S7Parser = require('../../src/s7protocol/s7parser.js');
const S7ItemGroup = require('../../src/s7itemGroup.js');

const { proto } = constants;

function serialize(msg) {
    return new Promise((resolve) => {
        const serializer = new S7Serializer();
        serializer.on('data', resolve);
        serializer.write(msg);
    });
}

function parse(buffer) {
    return new Promise((resolve, reject) => {
        const parser = new S7Parser();
        parser.on('data', resolve);
        parser.on('error', reject);
        parser.write(buffer);
    });
}

function byteItem(address, value) {
    return {
        param: { syntax: proto.syntax.S7ANY, transport: proto.transport.BYTE, area: proto.area.DB, db: 1, address, length: 1 },
        data: { returnCode: 0, transportSize: proto.dataTransport.BBYTE, data: Buffer.from([value]) }
    };
}

function writeRequest(items) {
    return {
        header: { type: proto.type.REQUEST, rid: 0, pduReference: 7 },
        param: { function: proto.function.WRITE_VAR, items: items.map(i => i.param) },
        data: { items: items.map(i => i.data) }
    };
}

// Endpoint double for S7ItemGroup: fixed PDU size, records the write requests it is asked to send
function fakeEndpoint(pduSize) {
    const writes = [];
    return {
        writes,
        pduSize,
        isConnected: true,
        on() {}, once() {}, removeListener() {},
        writeVars: async (items) => { writes.push(items); return items.map(() => ({ returnCode: proto.retval.DATA_OK })); }
    };
}

describe('S7 fill bytes', () => {

    describe('WriteVar request serialization (#16)', () => {

        it('pads odd-length data items except the last one', async () => {
            const buf = await serialize(writeRequest([byteItem(0, 0x11), byteItem(1, 0x22), byteItem(2, 0x33)]));
            // header (10) + params (2 + 3*12)
            const data = buf.subarray(10 + 2 + 36);
            expect(data.toString('hex')).to.equal(
                '0004000811' + '00' +   // item 1 + fill byte
                '0004000822' + '00' +   // item 2 + fill byte
                '0004000833');          // last item, no fill byte
            expect(buf.readUInt16BE(8)).to.equal(data.length); // header data length matches
            expect(buf.length).to.equal(10 + 2 + 36 + 17);
        });

        it('does not pad even-length items, nor a single odd item', async () => {
            const word = {
                param: { syntax: proto.syntax.S7ANY, transport: proto.transport.BYTE, area: proto.area.DB, db: 1, address: 4, length: 2 },
                data: { returnCode: 0, transportSize: proto.dataTransport.BBYTE, data: Buffer.from([0xaa, 0xbb]) }
            };
            const two = await serialize(writeRequest([word, byteItem(6, 0x44)]));
            expect(two.subarray(10 + 2 + 24).toString('hex')).to.equal('00040010aabb' + '0004000844');

            const single = await serialize(writeRequest([byteItem(0, 0x55)]));
            expect(single.readUInt16BE(8)).to.equal(5);
            expect(single.subarray(-5).toString('hex')).to.equal('0004000855');
        });

        it('round-trips through S7Parser with the right values', async () => {
            const values = [0x11, 0x22, 0x33, 0x44, 0x55];
            const buf = await serialize(writeRequest(values.map((v, i) => byteItem(i * 2, v))));
            const msg = await parse(buf);
            expect(msg.data.items.map(i => i.data[0])).to.deep.equal(values);
        });
    });
});
