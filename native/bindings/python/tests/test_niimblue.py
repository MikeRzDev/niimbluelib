"""Tests for the Python bindings (no printer needed): python -m unittest discover -s bindings/python/tests

Same fixtures as the Go tests (native/go/testdata): a recorded B1 session for the
virtual printer and the 30x20 mm asset tag template from the NiimBlue editor.
"""

import json
import os
import threading
import time
import unittest

import niimblue

TESTDATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "go", "testdata")
with open(os.path.join(TESTDATA, "b1_print_dump.txt"), encoding="utf-8") as f:
    B1_DUMP = f.read()
with open(os.path.join(TESTDATA, "asset-tag.niim"), "rb") as f:
    ASSET_TAG = f.read()
ASSET_DATA = {
    "uuid": "794ad7ca-1ae2-451e-b06a-d93fd303e9d9",
    "asset_name": "Oppenheimer",
    "asset_type": "Compute Node",
    "site": "Manhattan",
}
NO_HEARTBEAT = {"heartbeat": False}


class NiimblueTest(unittest.TestCase):
    def setUp(self):
        self.p = niimblue.Printer()

    def tearDown(self):
        self.p.close()

    def test_versions(self):
        self.assertTrue(niimblue.version())
        self.assertRegex(niimblue.niimbluelib_version(), r"^\d+\.\d+\.\d+")
        self.assertIsInstance(niimblue.list_serial_ports(), list)

    def test_render_template(self):
        label = self.p.render_template_rgba(ASSET_TAG, ASSET_DATA)
        self.assertEqual((label.width, label.height, label.print_direction), (240, 160, "top"))
        self.assertEqual(len(label.pixels), 240 * 160 * 4)
        black = sum(1 for i in range(0, len(label.pixels), 4) if label.pixels[i] == 0)
        self.assertGreater(black, 2000)
        # JSON string input works too for json params
        self.assertEqual(self.p.render_template(ASSET_TAG, json.dumps(ASSET_DATA))["width"], 240)

    def test_template_tags(self):
        self.assertEqual(self.p._call_binary("templateTags", None, ASSET_TAG), ["uuid", "asset_name", "asset_type", "site"])
        # Only .niim packages, not template JSON
        with self.assertRaises(niimblue.NiimError) as e:
            self.p.template_tags(b'{"format":"niimblue-template"}')
        self.assertIn(".niim template package", e.exception.message)

    def test_print_template_on_virtual_printer(self):
        events = []
        self.p.on_event(lambda name, payload: events.append(name))
        with self.assertRaises(niimblue.NiimError) as e:
            self.p.print_template(ASSET_TAG, ASSET_DATA)
        self.assertEqual(e.exception.code, niimblue.NiimError.OPERATION)

        info = self.p.connect_virtual(B1_DUMP, NO_HEARTBEAT)
        self.assertEqual(info["printTask"], "B1")
        res = self.p.print_template(ASSET_TAG, [ASSET_DATA], {"quantity": 1, "statusPollIntervalMs": 20})
        self.assertEqual((res["labels"], res["pages"]), (1, 1))
        self.assertIn("connect", events)
        self.assertIn("printend", events)

        with self.assertRaises(niimblue.NiimError) as e:
            self.p.print_template(ASSET_TAG, [ASSET_DATA, {"uuid": "x"}])
        self.assertIn("asset_name", e.exception.message)
        self.p.disconnect()

    def test_unicode_round_trip(self):
        method = "nö-such-mëthod-\U0001f600"
        with self.assertRaises(niimblue.NiimError) as e:
            self.p.call(method)
        self.assertTrue(e.exception.message.endswith(method), e.exception.message)
        with self.assertRaises(niimblue.NiimError) as e:
            self.p.call("a\0b")
        self.assertEqual(e.exception.code, niimblue.NiimError.INVALID_ARG)

    def test_custom_transport_runs_on_library_thread(self):
        writes, threads = [], set()

        def write(data):
            writes.append(data)
            threads.add(threading.get_ident())
            return False  # fail every write

        with self.assertRaises(niimblue.NiimError) as e:
            self.p.connect_custom(write, NO_HEARTBEAT)
        self.assertTrue(writes)
        self.assertNotIn(threading.get_ident(), threads)
        self.assertIn(e.exception.code, (niimblue.NiimError.OPERATION, niimblue.NiimError.TRANSPORT))

    def test_reentrant_call_fails(self):
        codes = []

        def handler(name, _):
            if name == "connect":
                try:
                    self.p.call("isConnected")
                except niimblue.NiimError as err:
                    codes.append(err.code)

        self.p.on_event(handler)
        self.p.connect_virtual(B1_DUMP, NO_HEARTBEAT)
        self.assertEqual(codes, [niimblue.NiimError.REENTRANT])

    def test_swap_handlers_while_events_fire(self):
        counts = {"a": 0, "b": 0}

        def b(name, _):
            counts["b"] += 1

        def a(name, _):
            counts["a"] += 1
            if name == "heartbeat":
                self.p.on_event(b)  # from inside a handler

        self.p.on_event(a)
        self.p.connect_virtual(B1_DUMP, {"heartbeatIntervalMs": 10})
        end = time.monotonic() + 0.3
        i = 0
        while time.monotonic() < end:
            self.p.on_event([a, None, b][i % 3])
            i += 1
            time.sleep(0.001)
        self.p.on_event(b)
        before = counts["b"]
        time.sleep(0.15)
        self.assertGreater(counts["b"], before)

    def test_closed_printer(self):
        p = niimblue.Printer()
        p.close()
        p.close()
        with self.assertRaises(niimblue.NiimError) as e:
            p.call("isConnected")
        self.assertEqual(e.exception.code, niimblue.NiimError.CLOSED)

    def test_parallel_printers(self):
        errors = []

        def work():
            try:
                with niimblue.Printer() as p:
                    p.connect_virtual(B1_DUMP, NO_HEARTBEAT)
                    for _ in range(3):
                        p.render_template(ASSET_TAG, ASSET_DATA)
            except Exception as err:  # noqa: BLE001
                errors.append(err)

        threads = [threading.Thread(target=work) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])



    def test_print_batch_and_queue(self):
        p = self.p
        p.connect_virtual(B1_DUMP, NO_HEARTBEAT)
        px = bytes(0 if (x // 8 + y // 8) % 2 == 0 else 255 for y in range(64) for x in range(120))
        page = {"pixels": px, "width": 120, "height": 64, "options": {"format": "gray"}}
        opts = {"statusPollIntervalMs": 20}

        # The virtual printer always reports "page 1 of 1": single page jobs only.
        res = p.print_batch([page], opts)
        self.assertEqual(res["pages"], 1)
        self.assertEqual(res["images"], [{"cols": 120, "rows": 64, "quantity": 1}])
        self.assertGreater(res["jobId"], 0)

        with self.assertRaises(niimblue.NiimError) as ctx:
            p.print_batch([page, dict(page, pixels=px[:10])], opts)
        self.assertIn("page 2", str(ctx.exception))
        with self.assertRaises(niimblue.NiimError) as ctx:
            p.print_batch([], opts)
        self.assertIn("no pages", str(ctx.exception))

        job = p.submit([page], opts)
        self.assertIn(job["state"], ("queued", "printing"))
        self.assertEqual(p.wait_job(job["id"])["state"], "done")

        p.pause_queue()
        a = p.submit([page])["id"]
        b = p.submit([page])["id"]
        self.assertEqual(p.job(a)["state"], "queued")
        self.assertEqual(p.cancel_job(a)["state"], "cancelled")
        self.assertEqual(p.clear_queue(), 1)
        with self.assertRaises(niimblue.NiimError) as ctx:
            p.wait_job(b)
        self.assertIn("cancelled", str(ctx.exception))
        p.resume_queue()
        self.assertIn(b, [j["id"] for j in p.jobs()])


    def test_png_printer(self):
        p = self.p
        info = p.connect_png({"model": "B1"})
        self.assertEqual(info["printTask"], "B1")
        res = p.print_template(ASSET_TAG, ASSET_DATA, {"statusPollIntervalMs": 5})
        pages = p.png_pages(res["jobId"])
        self.assertEqual(len(pages), 1)
        self.assertEqual((pages[0]["width"], pages[0]["height"]), (240, 160))
        self.assertTrue(pages[0]["png"].startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(p.clear_png_pages(), 1)
    def test_generated_methods(self):
        p = self.p
        self.assertIn("B1", p.print_tasks())
        self.assertFalse(p.is_connected())
        self.assertFalse(p.queue_paused())
        p.pause_queue()
        self.assertTrue(p.queue_paused())
        p.resume_queue()
        self.assertEqual(p.clear_queue(), 0)
        with self.assertRaises(niimblue.NiimError):
            p.printer_info()
        self.assertEqual(p.template_tags(ASSET_TAG), ["uuid", "asset_name", "asset_type", "site"])
        # Binary payload through niim_call_bin
        with self.assertRaises(niimblue.NiimError):
            p.register_font("Junk", b"not a font")


if __name__ == "__main__":
    unittest.main()
