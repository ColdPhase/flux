"""Stdlib-only closed-schema checks; no browser, Docker or application acceptance."""
import ast
import copy
import hashlib
import importlib.util
import json
import re
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DRIVER = ROOT / 'app/tests/ui/live_editing_latency.py'
COLLECTOR = ROOT / 'scripts/collect_live_editing_queue.py'


def driver_protocol():
    """Compile the actual pure protocol functions without importing Playwright."""
    tree = ast.parse(DRIVER.read_text())
    names = {'exact_integer', 'canonical_uuid', 'strict_json', 'read_regular',
             'api_inventory', 'validated_rows', 'validate_finished', 'queue_evidence'}
    kept = []
    first_function = min(node.lineno for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)))
    for node in tree.body:
        if isinstance(node, ast.Import):
            kept.append(node)
        elif isinstance(node, ast.ImportFrom) and node.module in ('__future__', 'pathlib'):
            kept.append(node)
        elif isinstance(node, ast.Assign) and node.lineno < first_function:
            kept.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in names:
            kept.append(node)
    namespace = {}
    exec(compile(ast.Module(body=kept, type_ignores=[]), str(DRIVER), 'exec'), namespace)
    return namespace


def collector_protocol():
    spec = importlib.util.spec_from_file_location('live_queue_collector_schema', COLLECTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LiveEditingQueueSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.driver = driver_protocol()
        cls.collector = collector_protocol()

    def records(self):
        values = {field: 0 for field in self.collector.GAUGES + self.collector.PEAKS}
        first = dict(values, schema=1, apiInstance='api-one', kind='initial',
                     resourceId=None, generation=None, backpressured=False,
                     attemptedRecords=1, retainedRecords=1, droppedRecords=0)
        final = dict(first, kind='final', attemptedRecords=2, retainedRecords=2,
                     finalDrained=True, peakWikiCursorPending=1)
        return [first, final]

    def driver_result(self, records):
        # Zero-row partial evidence is only a protocol fixture, never a latency pass.
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            source, driver = 'a' * 40, 'b' * 64
            metadata = {'source_sha': source, 'driver_sha256': driver,
                        'server_queue_evidence': {'api_instances': ['api-one']}}
            marker = {'schema': 1, 'measurement_id': str(uuid.uuid4()), 'source_sha': source,
                      'driver_sha256': driver, 'api_instances': ['api-one'], 'planned_cases': [],
                      'completed_case_count': 0, 'scheduled_rows_written': 0,
                      'teardown_complete': True, 'finished_at': 1.0}
            finished = (json.dumps(marker) + '\n').encode()
            raw = b''.join((json.dumps(record) + '\n').encode() for record in records)
            seal = {'schema': 1, 'measurement_id': marker['measurement_id'], 'source_sha': source,
                    'api_instances': ['api-one'], 'measurement_finished_sha256': hashlib.sha256(finished).hexdigest(),
                    'raw_path': 'actual-queue.jsonl', 'raw_bytes': len(raw), 'raw_sha256': hashlib.sha256(raw).hexdigest(),
                    'record_count': len(records), 'complete': records[-1]['finalDrained'], 'dropped_records': 0,
                    'backpressured': False, 'final_drained': records[-1]['finalDrained'], 'end_reason': 'drained'}
            sealed = (json.dumps(seal) + '\n').encode()
            (directory / 'measurement-finished.json').write_bytes(finished)
            (directory / 'actual-queue.jsonl').write_bytes(raw)
            (directory / 'queue-seal.json').write_bytes(sealed)
            return self.driver['queue_evidence'](metadata, directory, [], finished, sealed)

    def test_all_three_closed_lists_have_exactly_26_unique_gauges(self):
        producer = (ROOT / 'app/apps/server/src/editing/telemetry.ts').read_text()
        block = producer.split('EDITING_RESOURCE_GAUGES=[', 1)[1].split('] as const', 1)[0]
        gauges = tuple(re.findall(r"'([A-Za-z]+)'", block))
        self.assertEqual(len(gauges), 26)
        self.assertEqual(len(set(gauges)), 26)
        self.assertEqual(gauges, self.collector.GAUGES)
        self.assertEqual(gauges, self.driver['QUEUE_GAUGES'])
        self.assertIn('wikiCursorPending', gauges)
        self.assertEqual(self.collector.PEAKS, self.driver['QUEUE_PEAKS'])

    def test_actual_pending_peak_survives_zero_final_in_both_consumers(self):
        records = self.records()
        for record in records:
            self.collector.validate_record(record, 'api-one')
            self.assertLessEqual(len(json.dumps(record).encode()) + 1, 4096)
        self.assertTrue(self.collector.terminal_state(records, ['api-one'])['drained'])
        result = self.driver_result(records)
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertEqual(result['mutation_maintained_peaks']['peakWikiCursorPending'], 1)

    def test_missing_gauge_or_peak_is_not_invented_as_zero(self):
        for omitted in ('wikiCursorPending', 'peakWikiCursorPending'):
            with self.subTest(omitted=omitted):
                records = self.records()
                del records[-1][omitted]
                with self.assertRaises(ValueError):
                    self.collector.validate_record(records[-1], 'api-one')
                with self.assertRaises(ValueError):
                    self.driver_result(records)

    def test_retained_pending_cursor_cannot_certify_drain(self):
        records = self.records()
        records[-1]['wikiCursorPending'] = 1
        with self.assertRaises(ValueError):
            self.collector.terminal_state(records, ['api-one'])
        with self.assertRaises(ValueError):
            self.driver_result(records)
        records[-1]['finalDrained'] = False
        self.assertFalse(self.collector.terminal_state(records, ['api-one'])['drained'])
        self.assertEqual(self.driver_result(records)['status'], 'INCOMPLETE')

    def test_historical_25_field_records_remain_historical(self):
        records = copy.deepcopy(self.records())
        for record in records:
            del record['wikiCursorPending'], record['peakWikiCursorPending']
        with self.assertRaises(ValueError):
            self.collector.terminal_state(records, ['api-one'])
        with self.assertRaises(ValueError):
            self.driver_result(records)


if __name__ == '__main__':
    unittest.main()
