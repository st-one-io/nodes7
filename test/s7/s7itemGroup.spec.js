//@ts-check
/*
    Copyright (c) 2026 George Vasiliades

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/
/*jshint esversion: 6, node: true*/

const { expect } = require('chai');
const { EventEmitter } = require('events');
const S7ItemGroup = require('../../src/s7itemGroup.js');
//@ts-ignore
const constants = require('../../src/constants.json');

const { proto } = constants;

function addressedEndpoint(pduSize) {
    const endpoint = new EventEmitter();
    //@ts-ignore
    endpoint.pduSize = pduSize;
    //@ts-ignore
    endpoint.readVars = async parts => parts.map(part => ({
        returnCode: proto.retval.DATA_OK,
        data: Buffer.from(Array.from({ length: part.length }, (_, i) => (part.address + i) & 0xff))
    }));
    return endpoint;
}

function expectedBytes(address) {
    const [, offset, length] = address.match(/BYTE(\d+)\.(\d+)/).map(Number);
    return Array.from({ length }, (_, i) => (offset + i) & 0xff);
}

describe('S7ItemGroup', () => {

    const overlappingSplits = [
        [61, 'DB1,BYTE0.26', 'DB1,BYTE22.18'],
        [240, 'DB1,BYTE0.205', 'DB1,BYTE201.18'],
        [480, 'DB1,BYTE0.445', 'DB1,BYTE441.18'],
        [960, 'DB1,BYTE0.925', 'DB1,BYTE921.18']
    ];

    for (const [pduSize, block, field] of overlappingSplits) {
        it(`should read an item that starts before a split part on a ${pduSize}-byte PDU`, async () => {
            const group = new S7ItemGroup(addressedEndpoint(pduSize));
            const addresses = { block, field };
            group.setTranslationCB(tag => addresses[tag]);
            group.addItems(Object.keys(addresses));

            const result = await group.readAllItems();

            expect(Array.from(result.block)).to.be.deep.equal(expectedBytes(block));
            expect(Array.from(result.field)).to.be.deep.equal(expectedBytes(field));
        });
    }
});
