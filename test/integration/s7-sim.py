"""Strict Siemens S7 PLC simulator for integration tests (python-snap7 server).

python-snap7's server only applies the first item of a multi-item write and does not
enforce the negotiated PDU size. This subclass behaves like a real CPU on both points:
- WriteVar: every item is applied; the data section must follow the S7comm layout (a fill
  byte after each odd-length item except the last), otherwise error 0x8104 like a PLC.
- ReadVar: a response longer than the negotiated PDU is refused with error 0x8500.

Requests longer than the negotiated PDU are refused with 0x8500 too.

Memory: DB1, 4096 bytes. Usage: s7-sim.py [port]
"""
import ctypes
import struct
import sys
import time

import snap7
from snap7.type import SrvArea
from snap7.server import S7Area

PDU_SIZE = 480
DB1_SIZE = 4096

# transport sizes whose length field is in bits
BIT_LENGTH_TRANSPORTS = {0x03, 0x04, 0x05}


class StrictServer(snap7.server.Server):
    def _db1(self):
        # the server keeps its own copy of the registered area
        return self.memory_areas[(S7Area.DB, 1)]

    def _parse_request(self, pdu):
        request = super()._parse_request(pdu)
        request["raw_pdu"] = bytes(pdu)
        return request

    def _ack(self, request, item_count, data):
        header = struct.pack(">BBHHHHBB", 0x32, 0x03, 0, request["sequence"], 2, len(data), 0, 0)
        return header + struct.pack(">BB", 0x05, item_count) + bytes(data)

    def _handle_write_area(self, request, client_address):
        pdu = request["raw_pdu"]
        if len(pdu) > PDU_SIZE:
            return self._build_error_response(request, 0x8500)
        _, _, _, _, param_len, data_len = struct.unpack(">BBHHHH", pdu[:10])
        params = pdu[10:10 + param_len]
        data = pdu[10 + param_len:10 + param_len + data_len]
        item_count = params[1]
        if param_len != 2 + 12 * item_count:
            return self._build_error_response(request, 0x8104)

        items = []
        offset = 0
        for i in range(item_count):
            if offset + 4 > len(data):
                return self._build_error_response(request, 0x8104)
            transport = data[offset + 1]
            length = struct.unpack(">H", data[offset + 2:offset + 4])[0]
            size = (length + 7) // 8 if transport in BIT_LENGTH_TRANSPORTS else length
            offset += 4
            items.append(data[offset:offset + size])
            offset += size
            if size % 2 and i < item_count - 1:
                offset += 1  # fill byte
        if offset != len(data):
            return self._build_error_response(request, 0x8104)

        codes = bytearray()
        for i, value in enumerate(items):
            spec = params[2 + 12 * i:2 + 12 * (i + 1)]
            word_len, count, db, area = spec[3], struct.unpack(">H", spec[4:6])[0], struct.unpack(">H", spec[6:8])[0], spec[8]
            address = struct.unpack(">I", b"\x00" + spec[9:12])[0]
            if area != 0x84 or db != 1:
                codes.append(0x0A)  # object does not exist
                continue
            memory = self._db1()
            with self.area_locks[(S7Area.DB, 1)]:
                if word_len == 0x01:  # BIT
                    byte, bit = divmod(address, 8)
                    memory[byte] = (memory[byte] | (1 << bit)) if value[0] & 1 else (memory[byte] & ~(1 << bit))
                else:
                    start = address // 8
                    if start + len(value) > len(memory):
                        codes.append(0x05)  # address out of range
                        continue
                    memory[start:start + len(value)] = value
            codes.append(0xFF)
        return self._ack(request, item_count, codes)

    def _handle_read_area(self, request, client_address):
        if len(request["raw_pdu"]) > PDU_SIZE:
            return self._build_error_response(request, 0x8500)
        response = super()._handle_read_area(request, client_address)
        if response and len(response) > PDU_SIZE:
            return self._build_error_response(request, 0x8500)
        return response


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 10102
    db1 = (ctypes.c_ubyte * DB1_SIZE)()
    struct.pack_into(">f", db1, 0, 21.5)  # DB1,REAL0
    struct.pack_into(">f", db1, 4, 1.25)  # DB1,REAL4
    struct.pack_into(">h", db1, 8, 42)  # DB1,INT8
    db1[12] = 0b00000001  # DB1,X12.0 = true
    server = StrictServer()
    server.register_area(SrvArea.DB, 1, db1)
    server.start(tcp_port=port)
    print("S7 sim on", port, flush=True)
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
