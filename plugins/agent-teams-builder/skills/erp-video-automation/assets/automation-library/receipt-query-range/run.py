def run(data, runs, run_id):
    return {"ok": False, "stage": "needs_calibration", "ERP_touched": False,
            "reason": "Date-range receipt query has not been calibrated; no ERP action sent."}
