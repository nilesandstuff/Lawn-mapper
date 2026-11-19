package app.routereader

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * The reading itself: scroll the list on screen to the top, then read it a
 * page at a time on the way down. Each swipe moves a little over half the
 * list, so pages overlap and no card is cut on both; the planner drops the
 * repeats. It stops at the bottom (a swipe that changes nothing) or after
 * 60 pages.
 *
 * A page is the text on screen with its place (when the app gives its text
 * to Android, as most do), or else a screenshot.
 */
class Reader(private val service: ReaderService) {

    data class Item(val text: String, val box: Rect)

    fun read(progress: (String) -> Unit): ReadResult? {
        val dm = service.resources.displayMetrics
        val width = dm.widthPixels
        val height = dm.heightPixels
        var root = service.appRoot() ?: return null
        val app = root.packageName?.toString() ?: "?"
        val fallback = Rect(0, height / 5, width, height * 4 / 5)
        var area = scrollable(root)?.let { ReaderService.boundsOf(it) }?.takeIf { it.height() > height / 4 } ?: fallback

        // 1. to the top
        progress("To the top…")
        for (i in 0 until 40) {
            val before = signature(items(root))
            val list = scrollable(root)
            val acted = list?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) == true
            if (!acted) service.swipe(area.centerX().toFloat(), area.top + area.height() * 0.15f, area.bottom - area.height() * 0.05f, 220)
            Thread.sleep(450)
            root = service.appRoot() ?: return null
            if (signature(items(root)) == before) break
        }
        Thread.sleep(300)

        // 2. down, a page at a time
        val pages = JSONArray()
        val images = mutableListOf<ByteArray>()
        var last = ""
        var textMode: Boolean? = null
        for (p in 0 until 60) {
            root = service.appRoot() ?: break
            val its = items(root)
            if (textMode == null) textMode = its.size >= 6 && its.count { it.text.any(Char::isDigit) } >= 3
            if (textMode == true) {
                val sig = signature(its)
                if (p > 0 && sig == last) break // the bottom: the swipe moved nothing
                last = sig
                pages.put(page(its))
            } else {
                val shot = service.screenshot() ?: if (p == 0) return null else break
                if (images.isNotEmpty() && images.last().contentEquals(shot)) break
                images.add(shot)
            }
            progress("Reading ${p + 1}…")
            area = scrollable(root)?.let { ReaderService.boundsOf(it) }?.takeIf { it.height() > height / 4 } ?: area
            service.swipe(area.centerX().toFloat(), area.top + area.height() * 0.80f, area.top + area.height() * 0.25f, 550)
            Thread.sleep(800)
        }
        if (pages.length() == 0 && images.isEmpty()) return null
        return ReadResult(app, width, height, pages, images)
    }

    /** The biggest scrollable thing on screen: the job list. */
    private fun scrollable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var best: AccessibilityNodeInfo? = null
        var bestArea = 0
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || depth > 60) return
            if (n.isScrollable && n.isVisibleToUser) {
                val b = ReaderService.boundsOf(n)
                val a = b.width() * b.height()
                if (a > bestArea) { best = n; bestArea = a }
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        walk(root, 0)
        return best
    }

    /** Every piece of text on screen, with where it sits. */
    private fun items(root: AccessibilityNodeInfo): List<Item> {
        val out = mutableListOf<Item>()
        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || depth > 60) return
            if (n.isVisibleToUser) {
                val text = n.text?.toString()?.trim().orEmpty()
                val desc = n.contentDescription?.toString()?.trim().orEmpty()
                val box = ReaderService.boundsOf(n)
                if (box.width() > 0 && box.height() > 0) {
                    if (text.isNotEmpty()) out.add(Item(text, box))
                    else if (desc.isNotEmpty() && n.childCount == 0) out.add(Item(desc, box))
                }
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
        }
        walk(root, 0)
        return out.distinctBy { "${it.text}|${it.box}" }
    }

    private fun signature(items: List<Item>) = items.joinToString("\n") { "${it.text}@${it.box.top}" }

    private fun page(items: List<Item>) = JSONObject().put("items", JSONArray().apply {
        for (it in items) put(JSONObject().put("t", it.text).put("l", it.box.left).put("tp", it.box.top).put("r", it.box.right).put("b", it.box.bottom))
    })
}
