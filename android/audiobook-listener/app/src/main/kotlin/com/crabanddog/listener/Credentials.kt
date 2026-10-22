package com.crabanddog.listener

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device credential is encrypted with a non-exportable Android Keystore key. */
class Credentials(context: Context) {
    private val prefs = context.getSharedPreferences("account", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey("audiobook-listener", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("audiobook-listener", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun readSlot(slot: String): String? = runCatching {
        val value = prefs.getString(slot, null) ?: return null
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
    }.getOrNull()
    private fun writeSlot(slot: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        check(prefs.edit().putString(slot, Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)).commit())
    }
    fun read(): String? = readSlot("credential")
    fun write(value: String) = writeSlot("credential", value)
    fun pending(): org.json.JSONObject? = readSlot("signin")?.let { runCatching { org.json.JSONObject(it) }.getOrNull() }
    fun pending(value: org.json.JSONObject) = writeSlot("signin", value.toString())
    fun clearPending() { check(prefs.edit().remove("signin").commit()) }
    fun clear() { prefs.edit().clear().apply() }
}
