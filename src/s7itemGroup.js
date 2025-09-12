//@ts-check
/*
  Copyright: (c) 2018-2020, Guilherme Francescon Cittolin <gfcittolin@gmail.com>
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

const { EventEmitter } = require('events');
//@ts-ignore
const constants = require('./constants.json');
const util = require('util');
const debug = util.debuglog('nodes7');

const S7Item = require('./s7item.js');
const S7Endpoint = require('./s7endpoint.js');
const NodeS7Error = require('./errors.js');

class S7ItemGroup extends EventEmitter {

    /**
     * 
     * @param {S7Endpoint} s7endpoint 
     * @param {object} [opts]
     * @param {boolean} [opts.skipOptimization=false] whether item optimization should be skipped
     * @param {number} [opts.optimizationGap=5] how many bytes away from the last item we may still try to optimize
     */
    constructor(s7endpoint, opts) {
        debug('new S7ItemGroup');

        opts = opts || {};

        super();

        this._endpoint = s7endpoint;
        this._skipOptimization = opts.skipOptimization;
        this._optimizationGap = opts.optimizationGap || 5;
        this._initParams();

        this._funcInvalidateReadPackets = () => this._invalidateReadPackets();
        this._endpoint.on('pdu-size', this._funcInvalidateReadPackets);
    }

    /**
     * Destroys this intance, releasing the used resources and 
     * the references on S7Endpoint
     */
    destroy() {
        debug('S7ItemGroup destroy');
        this._endpoint.removeListener('pdu-size', this._funcInvalidateReadPackets);
        this._endpoint = null;
        this._readPackets = null;
        this._items.clear();
    }

    /**
     * Initialize/reset state
     * @private
     */
    _initParams() {
        debug('S7ItemGroup _initParams');
        /** @private @type {Map<string,S7Item>} */
        this._items = new Map();
        this._readPackets = null;
        this._translationCallback = this._defaultTranslationCallback;
        this._lastRequestTime = null;
    }

    /**
     * A default translation callback that simply returns the same value
     * @private
     * @param {string} tag 
     */
    _defaultTranslationCallback(tag) {
        return tag;
    }

    /**
     * Prepare and optimize the read packets needed to be sent when reading this group
     * @private
     */
    _prepareReadPackets() {
        debug('S7ItemGroup _prepareReadPackets');

        // we still don't have the pdu size, so abort computation
        if (!this._endpoint.pduSize) {
            throw new NodeS7Error('ERR_ILLEGAL_STATE', 'PDU Size not available for optimization (not connected to the PLC yet?)');
        }

        this._readPackets = [];

        //get array of items
        let items = Array.from(this._items.values());

        if (!items.length) {
            return;
        }

        //sort them according to our rules
        items.sort(itemListSorter);

        const reqHeaderSize = 12;
        const resHeaderSize = 14;
        const reqPartSize = 12;
        const resPartSize = 4;
        const maxPayloadSize = this._endpoint.pduSize - 18;

        debug('S7ItemGroup _prepareReadPackets maxPayloadSize', maxPayloadSize);

        let packet;         //the current working request packet
        let part;           //the current working request packet's part 
        let pktReqLength;   //the current length of the request packet
        let pktResLength;   //the current length of the response of the packet
        let lastItem;       //the item processed on the last 

        /**
         * Group all items in packets with their parts
         * 
         * Iterates all items and try to group them in as few request packets as 
         * possible, each with as many parts as possible. All this while respecting
         * the max PDU size for the length of both request and response packets. 
         * Nearby items are grouped into the same part, reducing overhead.
         */
        for (const item of items) {

            let itemComplete = false;
            let itemLength = item.byteLength;
            let itemOffset = item.offset;

            while (!itemComplete) {

                let remainingLength = maxPayloadSize - pktResLength; //what does still fit on the response of the current packet
                let minRequiredLength = Math.min(itemLength, this._optimizationGap); //the minimum length we need to fit our item (or part of it)

                /* conditions to add to the same part*/
                if (packet && part
                    && this._isOptimizable(lastItem, item)
                    && (pktResLength + (itemOffset + minRequiredLength) - (part.address + part.length) <= maxPayloadSize)
                ) {
                    debug('S7ItemGroup _prepareReadPackets optimize', item._string);

                    let addedLength = Math.max(part.length, (itemOffset - part.address) + itemLength) - part.length;

                    // test if the whole item fits in this part
                    if (addedLength <= remainingLength) {

                        // compute the new part length to accomodate the new item
                        pktResLength += addedLength;
                        part.length += addedLength;

                        itemComplete = true;
                        debug('S7ItemGroup _prepareReadPackets optimize complete');
                    } else {
                        //doesn't fit, just put what we can
                        pktResLength += remainingLength;
                        part.length += remainingLength;

                        // ajust item for the consumed lenth on this part
                        let consumedItemLength = part.length - (itemOffset - part.address);
                        itemOffset += consumedItemLength;
                        itemLength -= consumedItemLength;

                        debug('S7ItemGroup _prepareReadPackets optimize partial', consumedItemLength);
                    }

                    //add the item to the part
                    part.items.push(item);

                    /* conditions to just add a new part to the current packet, without creating a new one*/
                } else if (packet
                    && (pktReqLength + reqPartSize) <= maxPayloadSize
                    && (pktResLength + resPartSize + minRequiredLength) <= maxPayloadSize
                ) {
                    debug('S7ItemGroup _prepareReadPackets item-new-part', item._string);

                    let partLength;
                    let partOffset = itemOffset;

                    // test if the whole item fits in this part
                    if ((pktResLength + resPartSize + itemLength) <= maxPayloadSize) {

                        partLength = itemLength;
                        itemComplete = true;
                        debug('S7ItemGroup _prepareReadPackets item-new-part complete');
                    } else {
                        //doesn't fit, just put what we can
                        let consumedItemLength = maxPayloadSize - pktResLength - resPartSize;
                        partLength = consumedItemLength;
                        itemOffset += consumedItemLength;
                        itemLength -= consumedItemLength;

                        debug('S7ItemGroup _prepareReadPackets item-new-part partial', consumedItemLength);
                    }

                    part = {
                        items: [item],
                        offsets: [],
                        area: item.areaCode,
                        db: item.dbNumber,
                        transport: item.readTransportCode,
                        address: partOffset,
                        length: partLength
                    };
                    packet.push(part);

                    pktReqLength += reqPartSize;
                    pktResLength += resPartSize + partLength;

                    /* nothing else we can optimize, create a new packet */
                } else {
                    debug('S7ItemGroup _prepareReadPackets item-new-packet', item._string);

                    //none of the conditions above met, add a new packet ...
                    packet = [];
                    this._readPackets.push(packet);

                    pktReqLength = reqHeaderSize;
                    pktResLength = resHeaderSize;

                    let partLength;
                    let partOffset = itemOffset;

                    // ... test if the whole item fits in this part ...
                    if ((pktResLength + resPartSize + itemLength) <= maxPayloadSize) {

                        partLength = itemLength;
                        itemComplete = true;

                        debug('S7ItemGroup _prepareReadPackets item-new-packet complete');
                    } else {
                        //doesn't fit, just put what we can
                        let consumedItemLength = maxPayloadSize - pktResLength - resPartSize;
                        partLength = consumedItemLength;
                        itemOffset += consumedItemLength;
                        itemLength -= consumedItemLength;

                        debug('S7ItemGroup _prepareReadPackets item-new-packet partial', consumedItemLength);
                    }

                    // ... and a new part with the item to it
                    part = {
                        items: [item],
                        offsets: [],
                        area: item.areaCode,
                        db: item.dbNumber,
                        transport: item.readTransportCode,
                        address: partOffset,
                        length: partLength
                    };
                    packet.push(part);

                    pktReqLength += reqPartSize;
                    pktResLength += resPartSize + partLength;
                }

                // if we still need to address the same item, the current packet is already full,
                // therefore lets force/optimize creating a new packet
                if (!itemComplete) {
                    packet = null;
                    part = null;
                }
            }

            lastItem = item;
        }

        // pre-calculating response offsets
        for (let i = 0; i < this._readPackets.length; i++) {

            const packet = this._readPackets[i];
            let lengthReq = reqHeaderSize;
            let lengthRes = resHeaderSize;
            debug('S7ItemGroup _prepareReadPackets pkt  #', i);

            for (let j = 0; j < packet.length; j++) {

                const part = packet[j];
                lengthReq += reqPartSize;
                lengthRes += resPartSize + part.length;
                debug('S7ItemGroup _prepareReadPackets part #', i, j, part.area, part.db, part.address, part.length);

                for (let k = 0; k < part.items.length; k++) {
                    const item = part.items[k];
                    debug('S7ItemGroup _prepareReadPackets item #', i, j, k, item._string);

                    let offset = item._getCopyBufferOffsets(part.address, part.length);
                    if (!offset) {
                        // if we reach here, we have a problem with our logic there
                        throw new Error(`Couldn't calculate offsets for item "${item._string}". Please report as a bug`);
                    }
                    part.offsets[k] = offset;
                }
            }
            debug('S7ItemGroup _prepareReadPackets pkt  #', i, lengthReq, lengthRes);
        }
    }

    /**
     * Invalidate/delete the current already-optimized read packets
     * @private
     */
    _invalidateReadPackets() {
        debug('S7ItemGroup _invalidateReadPackets');

        this._readPackets = null;
    }


    /**
     * Checks whether two S7Items can be grouped into the same request
     * 
     * @private
     * @param {S7Item} a the first S7Item
     * @param {S7Item} b the second S7Item
     * @returns a boolean indicating whether the two items can be grouped into the same request
     */
    _isOptimizable(a, b) {
        let result = !this._skipOptimization
            // a and b exist
            && a && b
            // same area code
            && a.areaCode === b.areaCode
            // is of type DB, I, Q or M
            && (b.areaCode === constants.proto.area.DB
                || b.areaCode === constants.proto.area.INPUTS
                || b.areaCode === constants.proto.area.OUTPUTS
                || b.areaCode === constants.proto.area.FLAGS
            )
            // same DB number (or both undefined)
            && a.dbNumber === b.dbNumber
            // within our gap factor
            && Math.abs(b.offset - a.offset - a.byteLength) < this._optimizationGap;
        debug('S7ItemGroup _isOptimizable', result);
        return result;
    }

    // ----- public methods

    /**
     * Sets a function that will be called whenever a tag name needs to be 
     * resolved to an address. By default, if none is given, then no translation
     * is performed
     * 
     * @param {null|undefined|function} func the function that translates tags to addresses
     * @throws an error when the supplied parameter is not a function
     */
    setTranslationCB(func) {
        debug("S7Endpoint setTranslationCB");

        if (typeof func === 'function') {
            this._translationCallback = func;
        } else if (func === null || func === undefined) {
            //set the default one
            this._translationCallback = this._defaultTranslationCallback;
        } else {
            throw new NodeS7Error('ERR_INVALID_ARGUMENT', "Parameter must be a function");
        }
    }

    /**
     * Add an item or a group of items to be read from "readAllItems"
     * 
     * @param {string|S7Item|Array<string>|Array<S7Item>} tags the tag or list of tags to be added
     * @throws if the supplied parameter is not a string or an array of strings
     * @throws if the format of the address of the tag is invalid
     */
    addItems(tags) {
        debug("S7ItemGroup addItems", tags);

        let tagsArr = Array.isArray(tags) ? tags : [tags];

        for (const tag of tagsArr) {
            debug("S7ItemGroup addItems item", tag);

            if (tag instanceof S7Item){
                this._items.set(tag.name, tag);
            } else if (typeof tag === 'string') {
                let addr = this._translationCallback(tag);
                let item = new S7Item(tag, addr);
    
                this._items.set(tag, item);
            } else {
                throw new NodeS7Error('ERR_INVALID_ARGUMENT', "Tags must be of type string or S7Item");
            }
        }

        // invalidate computed read packets
        this._invalidateReadPackets()
    }

    /**
     * Removes an item or a group of items to be read from "readAllItems"
     * 
     * @param {string|Array<string>} tags the tag or list of tags to be removed
     */
    removeItems(tags) {
        debug("S7ItemGroup removeItems", tags);

        if (!tags) {
            // clears all items by creating a new one
            this._items = new Map();
        } else if (Array.isArray(tags)) {
            for (const tag of tags) {
                this._items.delete(tag);
            }
        } else {
            this._items.delete(tags);
        }

        // invalidate computed read packets
        this._invalidateReadPackets();
    }

    /**
     * Writes the provided items with the provided values on the PLC
     * 
     * Writing items whose payload's size is bigger than the max packet 
     * size allowed by the PLC is intentionally not supported. This 
     * would need to be split among multiple packets and could cause issues
     * on the PLC depending on the programmed logic. You'll need to write 
     * items individually, and if synchronization is an issue, to write 
     * additional logic on the PLC for synchronization
     * 
     * @param {string|Array<string>} tags 
     * @param {*|Array<*>} values 
     * @throws {NodeS7Error} ERR_ITEM_TOO_BIG - when the item being written does not fit a single write request
     */
    async writeItems(tags, values) {
        debug("S7ItemGroup writeItems", tags, values);

        // don't do write optimizations, until we're
        // very sure on what we're doing

        if (this._endpoint === null) {
            throw new Error('Already destroyed');
        }

        if (typeof tags === 'string') {
            tags = [tags];
        } else if (!Array.isArray(tags)) {
            throw new NodeS7Error('ERR_INVALID_ARGUMENT', "Parameter tags must be a string or an array of strings");
        }

        if (!Array.isArray(values)) {
            values = [values];
        }

        if (values.length !== tags.length) {
            throw new NodeS7Error('ERR_INVALID_ARGUMENT', "Number of tags must match the number of values");
        }

        // nothing to write
        if (!tags.length) return;

        // not connected
        if (!this._endpoint.isConnected) {
            throw new NodeS7Error('ERR_NOT_CONNECTED', "Not connected");
        }

        const overheadPerItem = 16;
        const maxPayloadSize = this._endpoint.pduSize - 12;

        let reqPackets = [];
        let reqItems = [];
        let curRequestLength = 0;

        /* create an array of requests */
        for (let i = 0; i < tags.length; i++) {
            const tag = tags[i];
            const value = values[i];

            if (typeof tag !== 'string') {
                throw new NodeS7Error('ERR_INVALID_ARGUMENT', "Tags must be of string type");
            }

            // find item on our list first, so we don't need to create a new one
            let item = this._items.get(tag);
            if (!item) {
                let addr = this._translationCallback(tag);
                item = new S7Item(tag, addr);
            }

            let buf = item.getWriteBuffer(value);
            let reqItemLength = overheadPerItem + item.byteLengthWithFill;

            // TODO - maybe we can split an item in multiple write request parts
            if (reqItemLength > maxPayloadSize) {
                throw new NodeS7Error('ERR_ITEM_TOO_BIG', `Cannot write item with size greater than max payload of [${maxPayloadSize}]`, { tag });
            }

            // create a new request if it doesn't fit in the current one
            if (curRequestLength + reqItemLength > maxPayloadSize) {
                reqPackets.push(reqItems);
                reqItems = [];
                curRequestLength = 0;
            }

            curRequestLength += reqItemLength;

            let bitAddr = item.writeTransportCode === constants.proto.dataTransport.BBIT;
            reqItems.push({
                area: item.areaCode,
                db: item.dbNumber,
                address: bitAddr ? (item.offset << 3) + item.bitOffset : item.offset,
                transport: bitAddr ? constants.proto.transport.BIT : item.readTransportCode,
                dataTransport: item.writeTransportCode,
                data: buf,
                length: buf.length
            });
        }

        // add last request items
        reqPackets.push(reqItems);

        debug("S7ItemGroup writeItems requests", reqPackets);

        let requestTime = process.hrtime();
        let requests = reqPackets.map(pkt => this._endpoint.writeVars(pkt));
        let responses = await Promise.all(requests);
        this._lastRequestTime = process.hrtime(requestTime);

        debug("S7ItemGroup writeItems responses", responses);
        debug("S7ItemGroup writeItems requestTime", this._lastRequestTime);

        for (const resp of responses) {
            for (const res of resp) {
                let code = res.returnCode;
                if (code !== constants.proto.retval.DATA_OK) {
                    let errDescr = constants.proto.retvalDesc[code] || '<Unknown return code>';
                    throw new NodeS7Error(code, `Write error [0x${code.toString(16)}]: ${errDescr}`);
                }
            }
        }
    }

    /**
     * Reads the values of all items in this group
     */
    async readAllItems() {
        debug("S7ItemGroup readAllItems");

        if (this._endpoint === null) {
            throw new Error('Already destroyed');
        }

        let result = {};

        // prepare read packets if needed
        if (!this._readPackets) {
            this._prepareReadPackets();
        }

        if (!this._readPackets.length) {
            return result;
        }

        // request items and await the response
        debug("S7ItemGroup readAllItems requests", this._readPackets);

        let requestTime = process.hrtime();
        let requests = this._readPackets.map(pkt => this._endpoint.readVars(pkt));
        let responses = await Promise.all(requests);
        this._lastRequestTime = process.hrtime(requestTime);

        debug("S7ItemGroup readAllItems responses", responses);
        debug("S7ItemGroup readAllItems requestTime", this._lastRequestTime);

        // parse response
        for (let i = 0; i < this._readPackets.length; i++) {
            const req = this._readPackets[i];
            const res = responses[i];

            for (let j = 0; j < req.length; j++) {
                const reqPart = req[j];
                const resPart = res[j];

                // check for empty response
                if (!resPart) {
                    throw new NodeS7Error('ERR_UNEXPECTED_RESPONSE', `Empty response for request: Area [${reqPart.area}] DB [${reqPart.db}] Addr [${reqPart.address}] Len [${reqPart.length}]`
                        , { area: reqPart.area, db: reqPart.db, address: reqPart.address, length: reqPart.length });
                }

                // check response's error code
                if (resPart.returnCode != constants.proto.retval.DATA_OK) {
                    let errDesc = constants.proto.retvalDesc[resPart.returnCode] || `<Unknown error code ${resPart.returnCode}>`;
                    throw new NodeS7Error(resPart.returnCode, `Error returned from request of Area [${reqPart.area}] DB [${reqPart.db}] Addr [${reqPart.address}] Len [${reqPart.length}]: "${errDesc}"`
                        , { area: reqPart.area, db: reqPart.db, address: reqPart.address, length: reqPart.length })
                }

                // good to go, parse response
                for (let k = 0; k < reqPart.items.length; k++) {
                    const item = reqPart.items[k];
                    const offset = reqPart.offsets[k];
                    //use our pre-calculated offsets to directly copy the data
                    item._copyFromBuffer(resPart.data, offset);
                }
            }
        }

        // update values and map items into reult object
        this._items.forEach((item, tag) => {
            item.updateValueFromBuffer();
            result[tag] = item.value
        });

        return result;
    }

}

module.exports = S7ItemGroup;

/**
 * Custom item list sorter
 * @private
 * @param {S7Item} a 
 * @param {S7Item} b 
 */
function itemListSorter(a, b) {
    // Feel free to manipulate these next two lines...
    if (a.areaCode < b.areaCode) { return -1; }
    if (a.areaCode > b.areaCode) { return 1; }

    // Group first the items of the same DB
    if (a.addrtype === 'DB') {
        if (a.dbNumber < b.dbNumber) { return -1; }
        if (a.dbNumber > b.dbNumber) { return 1; }
    }

    // But for byte offset we need to start at 0.
    if (a.offset < b.offset) { return -1; }
    if (a.offset > b.offset) { return 1; }

    // Then bit offset
    if (a.bitOffset < b.bitOffset) { return -1; }
    if (a.bitOffset > b.bitOffset) { return 1; }

    // Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
    if (a.byteLength > b.byteLength) { return -1; }
    if (a.byteLength < b.byteLength) { return 1; }
}