"""Streamlit UI for the whitetail deer aging + antler scoring app."""

import hashlib
import io
import os
import uuid
from datetime import date

import streamlit as st
from PIL import ExifTags, Image

import db
import reports
from auth import RateLimiter, verify_password
from estimator import get_estimator

UPLOAD_DIR = os.environ.get("DEER_UPLOAD_DIR", "./uploads")
MAX_FILE_SIZE = 15 * 1024 * 1024  # 15MB

AGE_CLASSES = ["1.5", "2.5", "3.5", "4.5", "5.5+"]
AGE_METHODS = ["tooth wear", "cementum", "jawbone"]
SCORE_METHODS = ["B&C gross", "B&C net", "green"]

MAGIC_BYTES = {
    b"\xff\xd8\xff": "jpg",
    b"\x89PNG\r\n\x1a\n": "png",
}


def _detect_extension(data: bytes, filename: str) -> str | None:
    for magic, ext in MAGIC_BYTES.items():
        if data.startswith(magic):
            return ext
    # HEIC: ISO base media file, 'ftyp' box with heic/heix/mif1 brand near offset 4-12.
    if len(data) > 12 and data[4:8] == b"ftyp" and data[8:12] in (
        b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1",
    ):
        return "heic"
    lower = filename.lower()
    if lower.endswith((".jpg", ".jpeg")) and data.startswith(b"\xff\xd8"):
        return "jpg"
    return None


def _extract_exif(data: bytes):
    latitude, longitude, exif_datetime = None, None, None
    try:
        img = Image.open(io.BytesIO(data))
        exif = img._getexif()
        if not exif:
            return latitude, longitude, exif_datetime
        tags = {ExifTags.TAGS.get(k, k): v for k, v in exif.items()}
        exif_datetime = tags.get("DateTimeOriginal") or tags.get("DateTime")

        gps_info = tags.get("GPSInfo")
        if gps_info:
            gps = {ExifTags.GPSTAGS.get(k, k): v for k, v in gps_info.items()}

            def _to_degrees(value):
                d, m, s = value
                return float(d) + float(m) / 60 + float(s) / 3600

            if "GPSLatitude" in gps and "GPSLongitude" in gps:
                lat = _to_degrees(gps["GPSLatitude"])
                if gps.get("GPSLatitudeRef") == "S":
                    lat = -lat
                lon = _to_degrees(gps["GPSLongitude"])
                if gps.get("GPSLongitudeRef") == "W":
                    lon = -lon
                latitude, longitude = lat, lon
    except Exception:
        pass
    return latitude, longitude, exif_datetime


def upload_tab():
    st.header("Upload a Deer Photo")
    st.caption("AI estimate, unverified — actual age/score are only confirmed after harvest.")

    uploaded = st.file_uploader("Photo (jpg, png, heic)", type=["jpg", "jpeg", "png", "heic"])
    if uploaded is None:
        return

    data = uploaded.read()
    if len(data) > MAX_FILE_SIZE:
        st.error(f"File is too large ({len(data) / 1e6:.1f}MB). Max size is 15MB.")
        return

    ext = _detect_extension(data, uploaded.name)
    if ext is None:
        st.error("Unrecognized file type. Please upload a jpg, png, or heic image.")
        return

    if ext != "heic":
        try:
            st.image(data, caption="Uploaded photo", use_container_width=True)
        except Exception:
            st.info("Preview unavailable for this image, but it was accepted.")
    else:
        st.info("HEIC photo accepted (preview not shown).")

    photo_sha256 = hashlib.sha256(data).hexdigest()
    existing = db.get_deer_by_sha256(photo_sha256)
    if existing:
        st.warning(
            f"This photo was already uploaded as deer_id **{existing['deer_id']}**. "
            "Use the Lookup tab to view it."
        )
        return

    lat, lon, exif_dt = _extract_exif(data)

    with st.form("upload_form"):
        st.subheader("Details (auto-filled from photo when available)")
        col1, col2 = st.columns(2)
        with col1:
            latitude = st.number_input("Latitude", value=float(lat) if lat is not None else 0.0, format="%.6f")
        with col2:
            longitude = st.number_input("Longitude", value=float(lon) if lon is not None else 0.0, format="%.6f")
        exif_datetime = st.text_input("Photo date/time", value=exif_dt or "")
        uploader_label = st.text_input("Label (optional)", value="")
        submitted = st.form_submit_button("Run AI Estimate & Save")

    if not submitted:
        return

    estimator = get_estimator()
    deer_id = uuid.uuid4().hex[:12]

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    photo_path = os.path.join(UPLOAD_DIR, f"{deer_id}.{ext}")
    with open(photo_path, "wb") as f:
        f.write(data)

    with st.spinner("Running AI estimate..."):
        prediction = estimator.predict(photo_path)

    record = {
        "deer_id": deer_id,
        "photo_path": photo_path,
        "photo_sha256": photo_sha256,
        "latitude": latitude or None,
        "longitude": longitude or None,
        "exif_datetime": exif_datetime or None,
        "estimated_age_class": prediction.age_class,
        "estimated_age_confidence": prediction.age_confidence,
        "estimated_score": prediction.score,
        "estimated_score_low": prediction.score_low,
        "estimated_score_high": prediction.score_high,
        "model_version": estimator.version,
        "uploader_label": uploader_label or None,
    }

    try:
        db.insert_deer(record)
    except Exception as e:
        os.remove(photo_path)
        st.error(f"Could not save this deer record: {e}")
        return

    st.success(f"Saved! Deer ID: `{deer_id}`")
    st.markdown("### AI Estimate — *unverified*")
    c1, c2 = st.columns(2)
    with c1:
        st.metric("Age Class", prediction.age_class, help="AI estimate, unverified")
        st.write(f"Confidence: {prediction.age_confidence:.0%}")
    with c2:
        st.metric("Score", f"{prediction.score:.1f}")
        st.write(f"Interval: {prediction.score_low:.1f} – {prediction.score_high:.1f}")
    for w in prediction.warnings:
        st.warning(w)


def lookup_tab():
    st.header("Look Up a Deer")
    deer_id = st.text_input("Deer ID")
    if not deer_id:
        return
    record = db.get_deer(deer_id.strip())
    if not record:
        st.error("No deer found with that ID.")
        return

    st.subheader(f"Deer `{record['deer_id']}`")
    st.markdown("**AI Estimate — *unverified***")
    c1, c2 = st.columns(2)
    with c1:
        st.write(f"Age class: {record['estimated_age_class']} ({record['estimated_age_confidence']:.0%} confidence)")
    with c2:
        st.write(
            f"Score: {record['estimated_score']} "
            f"({record['estimated_score_low']} – {record['estimated_score_high']})"
        )
    st.caption(f"Model: {record['model_version']} · Uploaded: {record['upload_date']}")

    if record["harvest_status"]:
        st.markdown("---")
        st.markdown("**Harvest Record — verified**")
        st.write(f"Harvest date: {record['harvest_date']}")
        st.write(f"Actual age class: {record['actual_age_class']} ({record['actual_age_method']})")
        st.write(f"Actual score: {record['actual_score']} ({record['actual_score_method']})")
        if record["notes"]:
            st.write(f"Notes: {record['notes']}")
    else:
        st.caption("Not yet marked as harvested.")


def admin_tab():
    st.header("Admin")

    if "admin_authed" not in st.session_state:
        st.session_state["admin_authed"] = False

    limiter = RateLimiter(st.session_state)

    if not st.session_state["admin_authed"]:
        if limiter.is_locked():
            st.error(f"Too many failed attempts. Try again in {limiter.seconds_remaining()}s.")
            return
        with st.form("admin_login"):
            password = st.text_input("Admin password", type="password")
            login = st.form_submit_button("Log in")
        if login:
            if verify_password(password):
                limiter.record_success()
                st.session_state["admin_authed"] = True
                st.rerun()
            else:
                limiter.record_failure()
                st.error("Incorrect password.")
        return

    st.success("Logged in as admin.")

    with st.form("harvest_form"):
        deer_id = st.text_input("Deer ID")
        harvested = st.checkbox("Mark harvested", value=True)
        harvest_date = st.date_input("Harvest date", value=date.today())
        actual_age_class = st.selectbox("Actual age class", AGE_CLASSES)
        actual_age_method = st.selectbox("Actual age method", AGE_METHODS)
        actual_score = st.number_input("Actual score", min_value=0.0, format="%.1f")
        actual_score_method = st.selectbox("Actual score method", SCORE_METHODS)
        notes = st.text_area("Notes")
        submitted = st.form_submit_button("Save")

    if not submitted:
        return

    record = db.get_deer(deer_id.strip())
    if not record:
        st.error("No deer found with that ID.")
        return

    if not harvested:
        st.warning("Harvested checkbox unchecked — nothing saved.")
        return

    db.mark_harvested(
        deer_id=deer_id.strip(),
        harvest_date=str(harvest_date),
        actual_age_class=actual_age_class,
        actual_age_method=actual_age_method,
        actual_score=actual_score,
        actual_score_method=actual_score_method,
        notes=notes or None,
    )

    updated = db.get_deer(deer_id.strip())
    st.success("Harvest record saved.")
    c1, c2 = st.columns(2)
    with c1:
        st.markdown("**AI Estimate (unverified)**")
        st.write(f"Age class: {updated['estimated_age_class']} ({updated['estimated_age_confidence']:.0%})")
        st.write(f"Score: {updated['estimated_score']}")
    with c2:
        st.markdown("**Actual (verified)**")
        st.write(f"Age class: {updated['actual_age_class']} ({updated['actual_age_method']})")
        st.write(f"Score: {updated['actual_score']} ({updated['actual_score_method']})")


def reports_tab():
    st.header("Reports")
    df = reports.harvested_dataframe()
    if df.empty:
        st.info("No harvested deer yet — reports will appear once records are verified.")
        return

    st.subheader("Age-Class Accuracy by Model Version")
    st.dataframe(reports.age_accuracy(df), use_container_width=True)

    st.subheader("Score Error by Model Version")
    st.dataframe(reports.score_error(df), use_container_width=True)

    st.subheader("Estimated vs Actual Score")
    plot_df = df.dropna(subset=["estimated_score", "actual_score"])[["estimated_score", "actual_score"]]
    if not plot_df.empty:
        import altair as alt

        lo = min(plot_df.min())
        hi = max(plot_df.max())
        scatter = alt.Chart(plot_df).mark_circle(size=80).encode(
            x=alt.X("actual_score", title="Actual Score"),
            y=alt.Y("estimated_score", title="Estimated Score"),
        )
        line_df = __import__("pandas").DataFrame({"x": [lo, hi], "y": [lo, hi]})
        line = alt.Chart(line_df).mark_line(color="red", strokeDash=[4, 4]).encode(x="x", y="y")
        st.altair_chart(scatter + line, use_container_width=True)

    st.subheader("Export Training Data")
    if st.button("Generate training CSV"):
        path = reports.export_training_csv("./training_export.csv")
        with open(path, "rb") as f:
            st.download_button("Download CSV", f, file_name="training_export.csv", mime="text/csv")


def main():
    st.set_page_config(page_title="Whitetail Deer Aging", page_icon="🦌", layout="wide")
    st.title("🦌 Whitetail Deer Aging + Antler Scoring")

    db.init_db()

    tab_upload, tab_lookup, tab_admin, tab_reports = st.tabs(
        ["Upload", "Lookup", "Admin", "Reports"]
    )
    with tab_upload:
        upload_tab()
    with tab_lookup:
        lookup_tab()
    with tab_admin:
        admin_tab()
    with tab_reports:
        reports_tab()


if __name__ == "__main__":
    main()
