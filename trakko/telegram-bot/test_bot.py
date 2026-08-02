import asyncio
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import bot


class PhoneNormalizationTests(unittest.TestCase):
    def test_normalizes_telegram_contact(self):
        self.assertEqual(bot._normalize_phone("91 98765-43210"), "+919876543210")

    def test_expands_indian_local_dependent_number(self):
        self.assertEqual(
            bot._normalize_dependent_phone("9900112233", "+919876543210"),
            "+919900112233",
        )

    def test_rejects_invalid_number(self):
        with self.assertRaises(ValueError):
            bot._normalize_phone("123")

    def test_validates_and_normalizes_mandate_amount(self):
        self.assertEqual(bot._valid_mandate_amount("₹500"), "500.00")
        self.assertEqual(bot._valid_mandate_amount("750.50"), "750.50")
        self.assertIsNone(bot._valid_mandate_amount("0"))
        self.assertIsNone(bot._valid_mandate_amount("50.999"))

    def test_understands_typed_definitive_answers(self):
        self.assertIs(bot._confirmation_answer("yes, approve"), True)
        self.assertIs(bot._confirmation_answer("Go ahead"), True)
        self.assertIs(bot._confirmation_answer("No, leave it"), False)
        self.assertIsNone(bot._confirmation_answer("show me milk"))

    def test_builds_one_checkbox_for_each_saved_address(self):
        addresses = [
            {
                "id": "101",
                "label": "Home",
                "formattedAddress": "Home: 12 Park Street, Kolkata 700016",
            },
            {
                "id": "202",
                "label": "Parents",
                "formattedAddress": "Parents: 8 Lake Road, Kolkata 700029",
            },
        ]
        markup = bot._address_selection_markup(addresses)
        self.assertEqual(len(markup.inline_keyboard), 3)
        self.assertEqual(
            markup.inline_keyboard[0][0].callback_data,
            "address:select:101",
        )
        self.assertEqual(markup.inline_keyboard[-1][0].callback_data, "address:add")
        self.assertIn("12 Park Street", bot._address_list_text(addresses))
        self.assertIn("8 Lake Road", bot._address_list_text(addresses))

    def test_parses_any_two_letter_address_country_code(self):
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: Parents | IN | 12 Park Street, Kolkata 700016"
            ),
            ("Parents", "IN", "12 Park Street, Kolkata 700016"),
        )
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: Home | US | 123 Main Street, New York, NY 10001"
            ),
            ("Home", "US", "123 Main Street, New York, NY 10001"),
        )
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: London | gb | 10 Downing Street, London SW1A 2AA"
            ),
            ("London", "GB", "10 Downing Street, London SW1A 2AA"),
        )
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: Parents | 12 Park Street, Kolkata 700016",
                "IN",
            ),
            ("Parents", "IN", "12 Park Street, Kolkata 700016"),
        )

    def test_address_country_picker_has_presets_and_other(self):
        markup = bot._address_country_markup()
        callbacks = [
            button.callback_data
            for row in markup.inline_keyboard
            for button in row
        ]
        self.assertIn("address:country:IN", callbacks)
        self.assertIn("address:country:US", callbacks)
        self.assertIn("address:country:OTHER", callbacks)
    def test_exposes_address_commands_and_keyboard_actions(self):
        commands = {entry.command for entry in bot.BOT_COMMANDS}
        self.assertTrue({"addresses", "reselect", "addaddress"}.issubset(commands))
        keyboard_labels = {
            button.text
            for row in bot.MAIN_KEYBOARD.keyboard
            for button in row
        }
        self.assertIn("Addresses", keyboard_labels)
        self.assertIn("Add Address", keyboard_labels)

    def test_legacy_multi_merchant_cart_is_blocked_from_checkout(self):
        text = bot._ucp_cart_text({
            "itemCount": 2,
            "merchantGroups": [{
                "merchant": "oziva",
                "merchantName": "OZiva",
                "items": [{"productName": "Plant Protein", "quantity": 1}],
                "subtotals": [{"currency": "INR", "amount": "999.00"}],
            }, {
                "merchant": "himalayawellness",
                "merchantName": "Himalaya Wellness",
                "items": [{"productName": "Neem Face Wash", "quantity": 1}],
                "subtotals": [{"currency": "INR", "amount": "199.00"}],
            }],
        })
        self.assertIn("OZiva", text)
        self.assertIn("Himalaya Wellness", text)
        self.assertIn("legacy cart mixes merchants", text)
        self.assertIsNone(bot._ucp_cart_checkout_markup({
            "merchantGroups": [{"merchant": "oziva"}, {"merchant": "himalayawellness"}],
        }))

    def test_cart_markup_can_remove_items_and_empty_cart(self):
        markup = bot._ucp_cart_checkout_markup({
            "items": [{"id": "42", "productName": "Neem Shampoo"}],
            "merchantGroups": [{"merchant": "himalayawellness", "merchantName": "Himalaya"}],
        })
        callbacks = [button.callback_data for row in markup.inline_keyboard for button in row]
        self.assertIn("cart:remove:42", callbacks)
        self.assertIn("cart:empty", callbacks)
        self.assertIn("cart:checkout:himalayawellness", callbacks)

    def test_shopping_message_requires_session_address_confirmation(self):
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            message=SimpleNamespace(text="find plant protein"),
        )
        context = SimpleNamespace(user_data={}, bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "get_pending_action", AsyncMock(return_value=None)),
            patch.object(bot, "_offer_address_or_ready", AsyncMock()) as offer,
            patch.object(bot, "_call_hermes", AsyncMock()) as hermes,
        ):
            asyncio.run(bot.handle_message(update, context))
        offer.assert_awaited_once()
        hermes.assert_not_awaited()

    def test_direct_product_search_uses_the_same_hermes_flow_as_other_messages(self):
        message = SimpleNamespace(text="find milk")
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_message=message,
            message=message,
        )
        context = SimpleNamespace(user_data={}, bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        search_result = {"message": "i found products from himalaya's live ucp"}
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "get_pending_action", AsyncMock(return_value=None)),
            patch.object(bot, "_address_session_confirmed", AsyncMock(return_value=True)),
            patch.object(bot, "_keep_typing", AsyncMock()),
            patch.object(bot, "_call_hermes", AsyncMock(return_value=search_result)) as hermes,
            patch.object(bot, "_send_hermes_result", AsyncMock()) as send_result,
            patch.object(bot, "_family_api", AsyncMock()) as family_api,
        ):
            asyncio.run(bot.handle_message(update, context))
        hermes.assert_awaited_once_with(1234, binding, "find milk")
        send_result.assert_awaited_once_with(update, search_result, binding)
        family_api.assert_not_awaited()

    def test_mandate_summary_only_shows_top_five(self):
        mandates = [
            {
                "id": f"mandate-{index}",
                "status": "active",
                "merchantName": f"Merchant {index}",
                "currency": "INR",
                "approvedAmount": str(index * 100),
                "remaining": str(index * 100),
            }
            for index in range(1, 8)
        ]
        message = bot._mandates_text(mandates, total_count=7, has_more=True)
        self.assertIn("Top Prava mandates: 5", message)
        self.assertIn("Merchant 5", message)
        self.assertNotIn("Merchant 6", message)
        self.assertIn("Showing 5 of 7", message)
        self.assertIn("Show All (30 Days)", message)

    def test_mandate_history_shows_all_records_returned_for_month(self):
        mandates = [
            {
                "id": "mandate-1",
                "status": "active",
                "merchantName": "Kapiva",
                "currency": "INR",
                "approvedAmount": "100",
                "remaining": "80",
                "updatedAt": "2026-08-01T12:00:00.000Z",
            },
            {
                "id": "mandate-2",
                "status": "paused",
                "merchantName": "OZiva",
                "currency": "INR",
                "approvedAmount": "500",
                "remaining": "500",
                "createdAt": "2026-07-15T12:00:00.000Z",
            },
        ]
        message = bot._mandates_text(mandates, history=True)
        self.assertIn("last 30 days: 2", message)
        self.assertIn("Kapiva", message)
        self.assertIn("OZiva", message)
        self.assertIn("activity: 2026-08-01", message)


class OnboardingRedirectTests(unittest.TestCase):
    def test_unknown_phone_redirects_to_hosted_onboarding(self):
        message = SimpleNamespace(
            contact=SimpleNamespace(user_id=99, phone_number="+919876543210"),
            reply_text=AsyncMock(),
        )
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_user=SimpleNamespace(id=99),
            message=message,
        )
        context = SimpleNamespace(user_data={"onboarding": {"legacy": True}})

        with patch.object(bot, "_lookup_family", AsyncMock(return_value=None)):
            result = asyncio.run(bot.handle_contact(update, context))

        self.assertEqual(result, bot.ConversationHandler.END)
        self.assertNotIn("onboarding", context.user_data)
        reply_markup = message.reply_text.await_args.kwargs["reply_markup"]
        button = reply_markup.inline_keyboard[0][0]
        self.assertEqual(button.text, "Complete Tokko onboarding")
        self.assertEqual(button.url, "https://tokko-drab.vercel.app")

    def test_completed_family_keeps_existing_connection_flow(self):
        binding = {
            "userId": 42,
            "customerId": "tokko_family_42",
            "familyPhone": "+919876543210",
            "profileComplete": True,
        }
        message = SimpleNamespace(
            contact=SimpleNamespace(user_id=99, phone_number="+919876543210"),
            reply_text=AsyncMock(),
        )
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_user=SimpleNamespace(id=99),
            message=message,
        )
        context = SimpleNamespace(user_data={})

        with (
            patch.object(bot, "_lookup_family", AsyncMock(return_value=binding)),
            patch.object(bot, "set_family_binding", AsyncMock()) as save_binding,
            patch.object(bot, "_offer_address_or_ready", AsyncMock()) as offer_address,
        ):
            result = asyncio.run(bot.handle_contact(update, context))

        self.assertEqual(result, bot.ConversationHandler.END)
        save_binding.assert_awaited_once_with(1234, binding)
        offer_address.assert_awaited_once_with(
            update,
            binding,
            "Found your family account. You're connected to Tokko.",
        )
        message.reply_text.assert_not_awaited()


class BindingPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_path = bot.DB_PATH
        bot.DB_PATH = os.path.join(self.temp_dir.name, "bridge.db")
        bot._init_db()

    def tearDown(self):
        bot.DB_PATH = self.original_path
        self.temp_dir.cleanup()

    def test_round_trips_tokko_user_binding(self):
        binding = {
            "userId": 42,
            "customerId": "tokko_family_42",
            "familyPhone": "+919876543210",
            "responseLanguage": "bn-IN",
        }
        asyncio.run(bot.set_family_binding(1234, binding))
        self.assertEqual(asyncio.run(bot.get_family_binding(1234)), binding)

    def test_round_trips_and_clears_pending_hermes_approval(self):
        action = {
            "token": "signed-approval-token",
            "description": "add milk to the cart",
            "expiresInSeconds": 600,
        }
        asyncio.run(bot.set_pending_action(1234, action))
        saved = asyncio.run(bot.get_pending_action(1234))
        self.assertEqual(saved["token"], action["token"])
        self.assertEqual(saved["description"], action["description"])
        asyncio.run(bot.clear_pending_action(1234))
        self.assertIsNone(asyncio.run(bot.get_pending_action(1234)))

    def test_round_trips_saved_card_choices_without_storing_card_numbers(self):
        choices = [{
            "token": "signed-card-choice",
            "brand": "visa",
            "last4": "4242",
            "isDefault": True,
        }]
        bot._set_pending_ucp_cards_sync(1234, choices)
        saved = bot._get_pending_ucp_card_sync(1234, 0)
        self.assertEqual(saved, choices[0])
        bot._clear_pending_ucp_cards_sync(1234)
        self.assertIsNone(bot._get_pending_ucp_card_sync(1234, 0))

    def test_round_trips_add_card_choice_for_mandate_setup(self):
        choices = [{
            "type": "add_card",
            "label": "Add a new saved card",
            "token": "signed-add-card-choice",
        }]
        bot._set_pending_ucp_cards_sync(1234, choices)
        saved = bot._get_pending_ucp_card_sync(1234, 0)
        self.assertEqual(saved["type"], "add_card")
        self.assertEqual(saved["token"], choices[0]["token"])
        self.assertEqual(bot._card_choice_label(saved), choices[0]["label"])
        bot._clear_pending_ucp_cards_sync(1234)


if __name__ == "__main__":
    unittest.main()
