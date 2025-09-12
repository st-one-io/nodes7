//@ts-check
/*
  Copyright: (c) 2018-2020, Guilherme Francescon Cittolin <gfcittolin@gmail.com>
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

const { EventEmitter } = require('events')
//@ts-ignore
const constants = require('./constants.json');
const util = require('util');
const debug = util.debuglog('nodes7');
const isoOnTcp = require('iso-on-tcp');

const S7Item = require('./s7item');
const S7Connection = require('./s7connection.js');
const NodeS7Error = require('./errors.js');

const CONN_DISCONNECTED = 0;
const CONN_CONNECTING = 1;
const CONN_CONNECTED = 2;
const CONN_DISCONNECTING = 3;

/** @typedef {S7Connection.BlockCountResponse} BlockCountResponse */
/** @typedef {S7Connection.ListBlockResponse} ListBlockResponse */
/** @typedef {import('stream').Duplex} Duplex */
/**
 * @typedef {object} BlockList
 * @property {ListBlockResponse[]} OB list of blocks of type OB
 * @property {ListBlockResponse[]} DB list of blocks of type DB
 * @property {ListBlockResponse[]} SDB list of blocks of type SDB
 * @property {ListBlockResponse[]} FC list of blocks of type FC
 * @property {ListBlockResponse[]} SFC list of blocks of type SFC
 * @property {ListBlockResponse[]} FB list of blocks of type FB
 * @property {ListBlockResponse[]} SFB list of blocks of type SFB
 */
/**
 * @typedef {object} ModuleInformation
 * @property {string} [moduleOrderNumber]
 * @property {string} [hardwareOrderNumber]
 * @property {string} [firmwareOrderNumber]
 */
/**
 * @typedef {object} ComponentIdentification
 * @property {string} [plcName] W#16#0001: Name of the automation system
 * @property {string} [moduleName] W#16#0002: Name of the module
 * @property {string} [plantID] W#16#0003: Plant designation of the module
 * @property {string} [copyright] W#16#0004: Copyright entry
 * @property {string} [serialNumber] W#16#0005: Serial number of the module
 * @property {string} [partType] W#16#0007: Module type name
 * @property {string} [mmcSerialNumber] W#16#0008: Serial number of the memory card
 * @property {number} [vendorId] W#16#0009: Manufacturer and profile of a CPU module - Vendor ID
 * @property {number} [profileId] W#16#0009: Manufacturer and profile of a CPU module - Profile ID
 * @property {number} [profileSpecific] W#16#0009: Manufacturer and profile of a CPU module - Profile-specific Id
 * @property {string} [oemString] W#16#000A: OEM ID of a module (S7-300 only)
 * @property {number} [oemId] W#16#000A: OEM ID of a module (S7-300 only)
 * @property {number} [oemAdditionalId] W#16#000A: OEM ID of a module (S7-300 only)
 * @property {string} [location] W#16#000B: Location ID of a module
 */
/**
 * This callback will be called whenever S7Endpoint needs to get a new 
 * communication stream to the PLC
 * @callback GetTransport
 * @returns {Promise<Duplex>}
 */

/**
 * Emitted when an error occurs with the underlying
 * transport or the underlying connection
 * @event S7Endpoint#error
 * @param {*} e the error
 */

/**
 * Represents a S7 PLC, handling the connection to it and
 * allowing to call methods that act on it
 */
class S7Endpoint extends EventEmitter {

    /**
     * Creates a new S7Endpoint. When supplying a {@link GetTransport} at the "customTransport"
     * option, S7Endpoint will call it to get a communication channel to the PLC. In this case,
     * the "host", "port", "rack" and "slot" parameters won't be used.
     * 
     * @param {object}  opts the options object
     * @param {string}  [opts.host='localhost'] the hostname or IP Address to connect to
     * @param {number}  [opts.port=102] the TCP port to connect to
     * @param {number}  [opts.rack=0] the rack on the PLC configuration
     * @param {number}  [opts.slot=2] the slot on the PLC configuration
     * @param {number}  [opts.srcTSAP=0x0100] the source TSAP, when connecting using TSAP method
     * @param {number}  [opts.dstTSAP=0x0102] the destination TSAP, when connecting using TSAP method
     * @param {GetTransport} [opts.customTransport] allows supplying a custom function for getting a transport stream to the PLC. See {@link GetTransport}
     * @param {number}  [opts.autoReconnect=5000] the time to wait before trying to connect to the PLC again, in ms. If set to 0, disables the functionality
     * @param {object}  [opts.s7ConnOpts] the {@link S7Connection} constructor options, allowing to fine-tune specific parameters
     * 
     * @throws {Error} Will throw an error if invalid options are passed
     */
    constructor(opts) {
        debug("new S7Endpoint", opts);

        super();

        opts = opts || {};

        /** @type {GetTransport} */
        this._getTransport = opts.customTransport || (() => this._createIsoTransport());

        this._autoReconnect = opts.autoReconnect !== undefined ? opts.autoReconnect : 5000;
        this._connOptsS7 = opts.s7ConnOpts || {};

        let dstTSAP;
        if (typeof opts.dstTSAP === 'number') {
            dstTSAP = opts.dstTSAP;
        } else {
            let rack = typeof opts.rack === 'number' ? opts.rack : 0;
            let slot = typeof opts.slot === 'number' ? opts.slot : 2;

            dstTSAP = 0x0100 | (rack << 5) | slot;
        }

        this._connOptsTcp = {
            host: opts.host,
            port: opts.port || 102,
            srcTSAP: opts.srcTSAP || 0x0100,
            dstTSAP: dstTSAP,
            forceClose: true //we don't send DR telegrams of ISO-on-TCP
        }

        this._initParams();

        if (this._autoReconnect > 0) {
            this._shouldConnect = true;
            this._connect();
        }
    }

    /**
     * Initialize internal variables
     * @private
     */
    _initParams() {
        this._connectionState = CONN_DISCONNECTED;
        /** @type {S7Connection} */
        this._connection = null;
        /** @type {Duplex} */
        this._transport = null;
        this._pduSize = null;
        this._reconnectTimer = null;
        /** @type {boolean} */
        this._shouldConnect = false;
    }

    /**
     * Initiates the connection process according to the 
     * selected transport type
     * @private
     */
    _connect() {
        debug("S7Endpoint _connect");

        clearTimeout(this._reconnectTimer);

        if (this._connectionState > CONN_DISCONNECTED) {
            debug("S7Endpoint _connect not-disconnected");
            return;
        }

        this._destroyConnection();
        this._destroyTransport();

        /**
         * Emitted when we start the connection process to the PLC
         * @event S7Endpoint#connecting
         */
        process.nextTick(() => this.emit('connecting'));

        this._connectionState = CONN_CONNECTING;

        let race = Promise.race([
            this._getTransport(),
            new Promise((res, rej) => setTimeout(() => rej(new NodeS7Error('ERR_TIMEOUT', 'Timeout connecting to the transport')), 10000).unref())
        ]);

        race.then((transport) => {
            this._transport.on('error', e => this._onTransportError(e));
            this._transport.on('close', () => this._onTransportClose());
            this._transport.on('end', () => this._onTransportEnd());
            this._createS7Connection();
            this._connection.connect();
        }).catch(e => this._onTransportError(e));
    }
 
    /**
     * Creates an ISO-on-TCP transport with the parameters
     * supplied on the constructor
     * @private
     * @returns {Promise<Duplex>}
     */
    _createIsoTransport() {
        debug("S7Endpoint _createIsoTransport");

        return new Promise((resolve, reject) => {
            // handler to reject the promise on connection-time errors
            const handleRejection = e => reject(e);

            this._transport = isoOnTcp.createConnection(this._connOptsTcp, () => {
                this._transport.off('error', handleRejection);
                resolve(this._transport);
            });
            this._transport.on('error', handleRejection);
        })
    }

    /**
     * Creates the S7Connection that will handle the communication
     * with the PLC through the "this._transport" socket
     * @private
     */
    _createS7Connection() {
        debug("S7Endpoint _createS7Connection");

        this._connection = new S7Connection(this._transport, this._connOptsS7);

        this._connection.on('error', e => this._onConnectionError(e));
        this._connection.on('connect', () => this._onConnectionConnected());
        this._connection.on('timeout', () => this._onConnectionTimeout());
    }

    /**
     * Destroys the current S7Connection
     * 
     * @private
     */
    _destroyConnection() {
        debug("S7Endpoint _destroyConnection");

        if (this._shouldConnect) this._scheduleReconnection();

        this._connectionState = CONN_DISCONNECTED;

        if (!this._connection) return;
        this._connection.destroy();
        this._connection = null;
    }

    /**
     * Destroys the underlying transport. This also
     * destroys the S7Connection
     * @private
     */
    _destroyTransport() {
        debug("S7Endpoint _destroyTransport");

        //if we're destroying the transport, the connection must also die
        this._destroyConnection();

        if (!this._transport) return;

        if (this._transport.destroy) {
            this._transport.destroy();
        } else if (this._transport._destroy) {
            this._transport._destroy(new Error(), () => {
                debug("S7Endpoint _destroyTransport _destroy-callback");
            });
        }

        this._transport = null;
        /**
         * Emitted when we have disconnected from the PLC
         * @event S7Endpoint#disconnect
         */
        this.emit('disconnect');
    }

    /**
     * Tries to gracefully close the underlying transport by
     * calling end()
     * @private
     */
    _closeTransport() {
        debug("S7Endpoint _closeTransport");

        this._connectionState = CONN_DISCONNECTED;

        if (!this._transport) return;

        this._transport.end();
    }

    /**
     * Starts the disconnection process by destroying the
     * S7Connection and then asking for the transport to close.
     * If the process was started by the user, it won't schedule
     * another reconnection
     * 
     * @private
     */
    _disconnect() {
        debug("S7Endpoint _disconnect");

        this._connectionState = CONN_DISCONNECTED;

        this._destroyConnection();
        this._closeTransport();

    }

    /**
     * Handles transport's "close" events
     * @private
     */
    _onTransportClose() {
        debug("S7Endpoint _onTransportClose");

        this._destroyTransport();
    }

    /**
     * Handles transport's "end" events
     * @private
     */
    _onTransportEnd() {
        debug("S7Endpoint _onTransportEnd");

        this._destroyTransport();
    }

    /**
     * Triggered when any request of the S7Connection
     * has timed out. Generally means we need to
     * reconnect to the PLC
     * @private
     */
    _onConnectionTimeout() {
        debug("S7Endpoint _onConnectionTimeout");

        // TODO maybe add an option to control this behavior
        this._disconnect();
    }

    /**
     * Handles transport's "error" events
     * @private
     * @param {Error} e 
     */
    _onTransportError(e) {
        debug("S7Endpoint _onTransportError", e);

        this._destroyTransport();

        this.emit('error', e);
    }

    /**
     * Handles connection's "error" events
     * @private
     * @param {Error} e 
     */
    _onConnectionError(e) {
        debug("S7Endpoint _onConnectionError", e);

        // errors from S7Connection should be 'softer' errors, so let's try a clean disconnect
        this._disconnect();

        this.emit('error', e);
    }

    /**
     * Schedule a reconnection to the PLC if this
     * was configured in the constructor options
     * @private
     */
    _scheduleReconnection() {
        debug("S7Endpoint _scheduleReconnection");

        clearTimeout(this._reconnectTimer);

        if (this._autoReconnect > 0) {
            this._reconnectTimer = setTimeout(() => {
                debug("S7Endpoint _scheduleReconnection timeout-fired");
                this._connect();
            }, this._autoReconnect);
        }
    }

    /**
     * Triggered when the connection is established
     * @private
     */
    _onConnectionConnected() {
        debug("S7Endpoint _onConnectionConnected");

        // clear any reconnection timer that may be there
        clearTimeout(this._reconnectTimer);

        if (this._pduSize != this._connection.pduSize) {
            /**
             * Emitted when the negotiated PDU size has changed
             * @event S7Connection#pdu-size
             * @param {number} pduSize the new PDU size negotiated
             */
            this.emit("pdu-size", this._connection.pduSize);
        }
        this._pduSize = this._connection.pduSize;

        this._connectionState = CONN_CONNECTED;
        /**
         * Emitted when we're connected to the PLC and
         * ready to communicate
         * @event S7Endpoint#connect
         */
        this.emit('connect');
    }

    // ----- public methods

    /**
     * Connects to the PLC. Note that this will be automatically
     * called if the autoReconnect parameter of the constructor 
     * is not zero.
     * @returns {Promise<void>}
     */
    connect() {
        debug("S7Endpoint connect");

        return new Promise((res, rej) => {
            this._shouldConnect = true;
            if (this._connectionState === CONN_CONNECTED) {
                res();
            } else if (this._connectionState === CONN_DISCONNECTING) {
                rej(new NodeS7Error('ERR_ILLEGAL_STATE', "Can't connect when connection state is 'DISCONNECTING' "))
            } else {
                this.once('connect', res);
                this.once('error', rej);
                this._connect();
            }
        });
    }


    /**
     * Disconnects from the PLC. 
     * @returns {Promise<void>}
     */
    disconnect() {
        debug("S7Endpoint disconnect");

        return new Promise((res, rej) => {
            this._shouldConnect = false;
            if (this._connectionState === CONN_DISCONNECTED) {
                clearTimeout(this._reconnectTimer);
                res();
            } else {
                this.once('disconnect', res);
                this.once('error', rej);
                this._disconnect();
            }
        });
    }

    /**
     * Whether we're currently connected to the PLC or not
     * @returns {boolean}
     */
    get isConnected() {
        return this._connectionState === CONN_CONNECTED;
    }

    /**
     * The currently negotiated pdu size
     * @returns {number}
     */
    get pduSize() {
        return this._pduSize;
    }


    /**
     * Reads multiple values from multiple PLC areas. Care must be
     * taken not to exceed the maximum PDU size both of the request
     * and the response telegrams
     * 
     * @param {object[]} items the array of items to send
     * @param {number} items[].area the area code to be read
     * @param {number} [items[].db] the db number to be read (in case of a DB)
     * @param {number} items[].transport the transport length
     * @param {number} items[].address the address where to read from
     * @param {number} items[].length the number of elements to read (according to transport)
     * @returns {Promise<object>}
     */
    async readVars(items) {
        debug('S7Endpoint readVars', items);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new NodeS7Error('ERR_NOT_CONNECTED', "Not connected");
        }

        let arr = [];
        for (const item of items) {
            //first 3 bits for bit address is irrelevant for transports other than BIT
            let bitAddr = item.transport === constants.proto.transport.BIT;
            arr.push({
                syntax: constants.proto.syntax.S7ANY,
                area: item.area,
                db: item.db,
                transport: item.transport,
                address: bitAddr ? item.address : item.address << 3,
                length: item.length
            });
        }

        return await this._connection.requestReadVars(arr);
    }

    /**
     * Reads arbitrary length of data from a memory area of 
     * the PLC. This method accounts for the negotiated PDU 
     * size and splits it in multiple requests if necessary
     * 
     * @param {number} area the code of the area to be read
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @param {number} [db] the db number to be read (in the case area is a DB)
     * @returns {Promise<Buffer>}
     */
    async readArea(area, address, length, db) {
        debug('S7Endpoint readArea', area, address, length, db);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new NodeS7Error('ERR_NOT_CONNECTED', "Not connected");
        }

        let maxPayload = this._pduSize - 18; //protocol overhead
        let requests = [];
        for (let ptr = 0; ptr < length; ptr += maxPayload) {
            let item = [{
                area, db,
                address: address + ptr,
                transport: constants.proto.transport.BYTE,
                length: Math.min(length - ptr, maxPayload)
            }];
            requests.push(this.readVars(item));
        }

        let results = await Promise.all(requests)
        debug('S7Endpoint readArea response', results);

        let data = [];
        for (const res of results) {
            if (res.length > 1) throw new NodeS7Error('ERR_UNEXPECTED_RESPONSE', "Illegal item count on PLC response");

            let code = res[0].returnCode;
            if (code !== constants.proto.retval.DATA_OK) {
                let errDescr = constants.proto.retvalDesc[code] || '<Unknown return code>';
                throw new NodeS7Error(code, `Read error [0x${code.toString(16)}]: ${errDescr}`);
            }

            // TODO should we check the transport of the response?
            data.push(res[0].data);
        }

        return Buffer.concat(data);
    }

    /**
     * Reads data from a DB
     *
     * @param {number} db the number of the DB to be read
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readDB(db, address, length) {
        debug('S7Endpoint readDB', db, address, length);

        return await this.readArea(constants.proto.area.DB, address, length, db);
    }

    /**
     * Reads data from the inputs area
     *
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readInputs(address, length) {
        debug('S7Endpoint readInputs', address, length);

        return await this.readArea(constants.proto.area.INPUTS, address, length);
    }

    /**
     * Reads data from the outputs area
     *
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readOutputs(address, length) {
        debug('S7Endpoint readOutputs', address, length);

        return await this.readArea(constants.proto.area.OUTPUTS, address, length);
    }

    /**
     * Reads data from the flags (memory / merker) area
     *
     * @param {number} address the address where to read from
     * @param {number} length the amount of bytes to read
     * @returns {Promise<Buffer>}
     */
    async readFlags(address, length) {
        debug('S7Endpoint readFlags', address, length);

        return await this.readArea(constants.proto.area.FLAGS, address, length);
    }

    /**
     * Reads a S7Item individually
     * 
     * @param {S7Item} item 
     */
    async readItem(item) {
        debug('S7Endpoint readItem');
        
        let req = item.getReadItemRequest();
        let res = await this.readVars([req]);
        item.readValueFromResponse(res[0], req);
        item.updateValueFromBuffer();

        return item.value;
    }

    /**
     * Writes multiple values onto multiple PLC areas. Care must be
     * taken not to exceed the maximum PDU size both of the request
     * and the response telegrams
     *
     * @param {object[]} items the array of items to send
     * @param {number} items[].area the area code to be read
     * @param {number} [items[].db] the db number to be read (in case of a DB)
     * @param {number} items[].transport the transport length
     * @param {number} items[].address the address where to read from
     * @param {number} items[].length the number of elements to read (according to transport)
     * @param {number} items[].dataTransport the transport of the buffer being written
     * @param {Buffer} items[].data the buffer to be written
     * @returns {Promise<object>}
     */
    async writeVars(items) {
        debug('S7Endpoint writeMultiVars', items);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new NodeS7Error('ERR_NOT_CONNECTED', "Not connected");
        }

        let param = [], data = [];
        for (const item of items) {
            //first 3 bits for bit address is irrelevant for transports other than BIT
            let bitAddr = item.transport === constants.proto.transport.BIT;

            param.push({
                syntax: constants.proto.syntax.S7ANY,
                area: item.area,
                db: item.db,
                transport: item.transport,
                address: bitAddr ? item.address : item.address << 3,
                length: item.length
            });
            data.push({
                transportSize: item.dataTransport,
                data: item.data
            });
        }

        return await this._connection.requestWriteVar(param, data);
    }

    /**
     * Writes arbitrary length of data into a memory area of 
     * the PLC. This method accounts for the negotiated PDU 
     * size and splits it in multiple requests if necessary
     * 
     * @param {number} area the code of the area to be written
     * @param {number} address the address where to write to
     * @param {Buffer} data the data to be written
     * @param {number} [db] the db number to be written (in the case area is a DB)
     * @returns {Promise<void>}
     */
    async writeArea(area, address, data, db) {
        debug('S7Endpoint writeArea', area, address, data, db);

        if (this._connectionState !== CONN_CONNECTED) {
            throw new NodeS7Error('ERR_NOT_CONNECTED', "Not connected");
        }

        let maxPayload = this._pduSize - 28; //protocol overhead
        let requests = [];
        let dataLength = data.length;
        for (let ptr = 0; ptr < dataLength; ptr += maxPayload) {
            let chunk = data.slice(ptr, Math.min(dataLength - ptr, maxPayload))
            let item = [{
                area, db,
                address: address + ptr,
                transport: constants.proto.transport.BYTE,
                dataTransport: constants.proto.dataTransport.BBYTE,
                data: chunk,
                length: chunk.length
            }];
            requests.push(this.writeVars(item));
        }

        let results = await Promise.all(requests)
        debug('S7Endpoint writeArea response', results);

        for (const res of results) {
            if (res.length > 1) throw new NodeS7Error('ERR_UNEXPECTED_RESPONSE', "Illegal item count on PLC response");

            let code = res[0].returnCode;
            if (code !== constants.proto.retval.DATA_OK) {
                let errDescr = constants.proto.retvalDesc[code] || '<Unknown return code>';
                throw new NodeS7Error(code, `Write error [0x${code.toString(16)}]: ${errDescr}`);
            }
        }
    }

    /**
     * Writes data into a DB
     *
     * @param {number} db the number of the DB to be written
     * @param {number} address the address where to write to
     * @param {Buffer} data the amount of bytes to write
     * @returns {Promise<void>}
     */
    async writeDB(db, address, data) {
        debug('S7Endpoint writeDB', db, address, data && data.length);

        return await this.writeArea(constants.proto.area.DB, address, data, db);
    }

    /**
     * Writes data into the outputs area
     *
     * @param {number} address the address where to write to
     * @param {Buffer} data the amount of bytes to write
     * @returns {Promise<void>}
     */
    async writeOutputs(address, data) {
        debug('S7Endpoint writeOutputs', address, data && data.length);

        return await this.writeArea(constants.proto.area.OUTPUTS, address, data);
    }

    /**
     * Writes data into the flags (memory / merker) area
     *
     * @param {number} address the address where to write to
     * @param {Buffer} data the amount of bytes to write
     * @returns {Promise<void>}
     */
    async writeFlags(address, data) {
        debug('S7Endpoint writeFlags', address, data && data.length);

        return await this.writeArea(constants.proto.area.FLAGS, address, data);
    }

    /**
     * Gets a count of blocks from the PLC of each type
     * @returns {Promise<BlockCountResponse>} an object with the block type as property key ("DB", "FB", ...) and the count as property value
     */
    async blockCount() {
        debug('S7Endpoint blockCount');

        return await this._connection.blockCount();
    }

    /**
     * List the available blocks of the requested type
     * @param {number|string} type the block name in string, or its ID
     * @returns {Promise<ListBlockResponse[]>}
     */
    async listBlocks(type) {
        debug('S7Endpoint listBlocks');

        return await this._connection.listBlocks(type);
    }

    /**
     * Gets the information buffer of the requested block
     * @param {string|number} type the block type
     * @param {number} number the block number
     * @param {string} [filesystem='A'] the filesystem being queried
     * @returns {Promise<Buffer>}
     */
    async getBlockInfo(type, number, filesystem) {
        debug('S7Endpoint getBlockInfo');

        return await this._connection.getBlockInfo(type, number, filesystem);
    }

    /**
     * Get info about all blocks from the PLC
     * @returns {Promise<Buffer[]>}
     */
    async getAllBlockInfo() {
        debug('S7Endpoint getAllBlockInfo');

        let res = [];
        let blockList = await this.listAllBlocks();

        const getByType = async typ => {
            for (const blk of blockList[typ]) {
                res.push(await this.getBlockInfo(typ, blk.number));
            }
        }

        await getByType('OB');
        await getByType('DB');
        await getByType('SDB');
        await getByType('FC');
        await getByType('SFC');
        await getByType('FB');
        await getByType('SFB');

        return res;
    }

    /**
     * List all blocks of all available types
     * @returns {Promise<BlockList>}
     */
    async listAllBlocks() {
        debug('S7Endpoint listAllBlocks');

        let res = {};
        res.OB = await this.listBlocks('OB');
        res.DB = await this.listBlocks('DB');
        res.SDB = await this.listBlocks('SDB');
        res.FC = await this.listBlocks('FC');
        res.SFC = await this.listBlocks('SFC');
        res.FB = await this.listBlocks('FB');
        res.SFB = await this.listBlocks('SFB');

        return res;
    }

    /**
     * Gets the PLC's date/time
     * @returns {Promise<Date>}
     */
    async getTime() {
        debug('S7Endpoint getTime');

        return await this._connection.getTime();
    }

    /**
     * Sets the PLC's date/time
     * @param {Date} [date=now] The date/time to be set. Defaults to the current timestamp
     * @returns {Promise<void>}
     */
    async setTime(date) {
        debug('S7Endpoint setTime', date);

        await this._connection.setTime(date);
    }

    /**
     * Reads the specified block from the PLC
     * @param {string|number} type 
     * @param {number} number 
     * @param {boolean} [headerOnly=false] if we should ask for module header (`$`) instead of complete (`_`)
     * @param {string} [filesystem='A'] the filesystem to query (`A`, `P` or `B`)
     * @returns {Promise<Buffer>}
     */
    async uploadBlock(type, number, headerOnly = false, filesystem = "A") {
        debug('S7Endpoint uploadBlock', type, number, headerOnly, filesystem);

        let blkTypeId;
        switch (typeof type) {
            case 'number':
                if (isNaN(type) || type < 0 || type > 255) {
                    throw new NodeS7Error('ERR_INVALID_ARGUMENT', `Invalid parameter for block type [${type}]`);
                }
                blkTypeId = type;
                break;
            case 'string':
                blkTypeId = constants.proto.block.subtype[type.toUpperCase()];
                if (blkTypeId === undefined) {
                    throw new NodeS7Error('ERR_INVALID_ARGUMENT', `Unknown block type [${type}]`);
                }
                break;
            default:
                throw new NodeS7Error('ERR_INVALID_ARGUMENT', `Unknown type for parameter block type [${type}]`);
        }

        if (!['A', 'P', 'B'].includes(filesystem)) {
            throw new NodeS7Error('ERR_INVALID_ARGUMENT', `Unknown filesystem [${filesystem}]`);
        }

        let fileId = headerOnly ? '$' : '_';
        let blkTypeString = blkTypeId.toString(16).padStart(2, '0').toUpperCase();
        let blkNumString = number.toString().padStart(5, '0');
        let filename = fileId + blkTypeString + blkNumString + filesystem;

        if (filename.length !== 9) {
            throw new Error(`Internal error on generated filename [${filename}]`);
        }

        return await this._connection.uploadBlock(filename);
    }

    /**
     * Uploads all active blocks from the PLC
     * @param {boolean} [strict=false] If true, errors on the upload of individual blocks will cause the whole upload to fail
     * @returns {Promise<Buffer[]>}
     */
    async uploadAllBlocks(strict) {
        debug('S7Endpoint uploadAllBlocks');

        let res = [];
        let blockList = await this.listAllBlocks();

        const uploadType = async typ => {
            for (const blk of blockList[typ]) {
                try {
                    res.push(await this.uploadBlock(typ, blk.number));
                } catch (e) {
                    debug('S7Endpoint uploadAllBlocks err-upload', typ, blk.number, e);
                    if (strict) throw e;
                }
            }
        }

        await uploadType('OB');
        await uploadType('DB');
        await uploadType('SDB');
        await uploadType('FC');
        await uploadType('SFC');
        await uploadType('FB');
        await uploadType('SFB');

        return res;
    }

    /**
     * Gets a SystemStatusList specified by its ID and Index
     * @param {number} [id=0] the SSL ID
     * @param {number} [index=0] the SSL Index
     * @param {boolean} [strict=false] Whether it should verify if the requested Ids and indexes match
     * @returns {Promise<Buffer[]>}
     */
    async getSSL(id = 0, index = 0, strict = false) {
        debug('S7Endpoint getSSL', id, index);

        let reqBuf = Buffer.alloc(4);
        reqBuf.writeUInt16BE(id, 0);
        reqBuf.writeUInt16BE(index, 2);

        let res = await this._connection.sendUserData(constants.proto.userData.function.CPU_FUNC,
            constants.proto.userData.subfunction.CPU_FUNC.READSZL, reqBuf);

        let resId = res.readUInt16BE(0);
        let resIdx = res.readUInt16BE(2);

        if (strict && (resId !== id || resIdx !== index)) {
            throw new NodeS7Error('ERR_UNEXPECTED_RESPONSE', `SSL ID/Index mismatch, requested [${id}]/[${index}], got [${resId}]/[${resIdx}]`, { resId, resIdx });
        }

        let entryLength = res.readUInt16BE(4);
        let entryCount = res.readUInt16BE(6);

        if (entryLength * entryCount !== res.length - 8) {
            throw new NodeS7Error('ERR_UNEXPECTED_RESPONSE', `Size mismatch, expecting [${entryCount}] x [${entryLength}] + 8, got [${res.length}]`, { entryCount, entryLength });
        }

        let retArray = [];
        for (let i = 0; i < entryCount; i++) {
            const ptr = 8 + (entryLength * i);
            retArray.push(res.slice(ptr, ptr + entryLength));
        }

        return retArray;
    }

    /**
     * Gets the available SSL IDs by querying SSL ID 0x000, Index 0x0000
     * @returns {Promise<number[]>}
     */
    async getAvailableSSL() {
        debug('S7Endpoint getAvailableSSL');

        let res = await this.getSSL(0, 0);
        return res.map(b => b.readUInt16BE(0));
    }

    /**
     * Gets and parses the 0x0011 SSL ID that contains, among other
     * infos, the equipment's order number.
     * This may not be supported by the PLC. In this case, an error
     * is thrown
     * @returns {Promise<ModuleInformation>}
     */
    async getModuleIdentification() {
        debug('S7Endpoint getModuleIdentification');

        let res = await this.getSSL(0x0011, 0);

        let moduleInfo = {
            moduleOrderNumber: null,
            hardwareOrderNumber: null,
            firmwareOrderNumber: null
        };

        for (const buf of res) {
            if (buf.length != 28) throw new NodeS7Error('ERR_UNEXPECTED_RESPONSE', `Unexpected buffer size of [${buf.length}] != 28`);

            // we're intentionally lefting the version/id fields out. Many ways of representing
            // this info were seen on the wild and finding a way to correctly parse all of
            // them seems to be pretty hard

            let id = buf.readUInt16BE(0);
            switch (id & 0xff) {
                case 1:
                    moduleInfo.moduleOrderNumber = buf.toString('ascii', 2, 22).trim();
                    break;
                case 6:
                    moduleInfo.hardwareOrderNumber = buf.toString('ascii', 2, 22).trim();
                    break;
                case 7:
                    moduleInfo.firmwareOrderNumber = buf.toString('ascii', 2, 22).trim();
                    break;
                default:
                // unknown, ignore it
            }
        }

        return moduleInfo;
    }

    /**
     * Gets and parses the 0x001c SSL ID that contains general information
     * about the device and the installation
     * This may not be supported by the PLC. In this case, an error
     * is thrown
     * @returns {Promise<ComponentIdentification>}
     */
    async getComponentIdentification() {
        debug('S7Endpoint getComponentIdentification');

        let devInfo = await this.getSSL(0x001c, 0);

        /** @type {ComponentIdentification} */
        let deviceInfo = {
            plcName: null,
            moduleName: null,
            plantID: null,
            copyright: null,
            serialNumber: null,
            partType: null,
            mmcSerialNumber: null,
            vendorId: null,
            profileId: null,
            profileSpecific: null,
            oemString: null,
            oemId: null,
            oemAdditionalId: null,
            location: null
        };

        for (const buf of devInfo) {
            let id = buf.readUInt16BE(0);

            switch (id & 0xff) {
                case 1:
                    deviceInfo.plcName = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                case 2:
                    deviceInfo.moduleName = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                case 3:
                    deviceInfo.plantID = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                case 4:
                    deviceInfo.copyright = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                case 5:
                    deviceInfo.serialNumber = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                case 7:
                    deviceInfo.partType = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                case 8:
                    deviceInfo.mmcSerialNumber = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                case 9:
                    deviceInfo.vendorId = buf.readUInt16BE(2);
                    deviceInfo.profileId = buf.readUInt16BE(4);
                    deviceInfo.profileSpecific = buf.readUInt16BE(2);
                    break;
                case 10:
                    deviceInfo.oemString = buf.toString('ascii', 2, 28).replace(/\x00/g, '');
                    deviceInfo.oemId = buf.readUInt16BE(28);
                    deviceInfo.oemAdditionalId = buf.readUInt32BE(30);
                    break;
                case 11:
                    deviceInfo.location = buf.toString('ascii', 2).replace(/\x00/g, '');
                    break;
                default:
                    //unknown id, ignore it
            }
        }

        return deviceInfo;
    }
}

module.exports = S7Endpoint
